import { describe, it, expect, vi } from 'vitest';
import { hash, randomBytes, randomUUID } from 'node:crypto';
import { buildServer } from '../src/server';
import { signSession, verifyDemandeOauth } from '../src/auth/token';
import { metadonneesRessource, metadonneesServeur } from '../src/oauth/metadonnees';
import { nouveauJeton, PREFIXE_CODE } from '../src/oauth/jetons';
import type { AccesOauth, CodeConsomme, NouveauxJetons, NouvelleAutorisation, AutorisationListee } from '../src/oauth/store.pg';
import type { OauthRouteDeps } from '../src/http/oauth';
import type { OauthConsentementRouteDeps } from '../src/http/oauth-consentement';
import type { GoogleIdentity } from '../src/auth/google';
import type { DepsMcp } from '../src/mcp/outils';
import { FakeQueue } from './fake-queue';
import { contactsV1Muets } from './aide/contacts-v1';
import { jamaisDesabonne } from './consentement';
import { mcpInerte, mcpWidgetsInertes } from './routes-inertes';

/**
 * LES ROUTES OAUTH DEVANT `/mcp` (tâche 6 du plan `2026-10-03-oauth-mcp.md`), sur le serveur construit.
 *
 * 🔴 Ce qui est protégé ici : le parcours entier de Claude (demande, consentement, code, échange, `/mcp`,
 * renouvellement, rejeu, révocation) ; aucune redirection vers une adresse non validée ; le rôle relu en base au
 * clic, jamais pris dans la preuve ; une preuve qui ne vaut que pour sa demande ; et rien de monté sans
 * `PUBLIC_API_URL`.
 *
 * ⚠️ Le magasin est un faux en mémoire qui reproduit les règles de `PgOauthStore` (code à usage unique, rotation,
 * rejeu qui révoque, rôle relu à la résolution). Ses requêtes, elles, sont éprouvées contre une vraie base par
 * `tests/integration/oauth-store.integration.test.ts`.
 */

const BASE = 'https://api.exemple.test';
const APP = 'https://console.exemple.test';
const SECRET = randomBytes(32).toString('hex');
const CC = 'https://claude.ai/oauth/claude-code-client-metadata';
const CLAUDE_AI = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const RETOUR = 'http://localhost:4567/callback';
const VERIF = randomBytes(32).toString('base64url');
const DEFI = hash('sha256', VERIF, 'base64url');
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

interface Compte { id: string; tenantId: string; tenantName: string; role: string; disabled: boolean }
interface Ligne {
  id: string; tenantId: string; userId: string; clientId: string; scopes: string[]; resource: string;
  acces: string | null; refresh: string | null; precedent: string | null; revoque: boolean;
}

/** Les comptes, par adresse : modifiables en cours de test (un admin rétrogradé, un espace créé). */
function comptesDeDepart(): Map<string, Compte[]> {
  return new Map([
    ['admin@x.fr', [
      { id: 'u-admin', tenantId: T1, tenantName: 'Espace Un', role: 'admin', disabled: false },
      { id: 'u-agent', tenantId: T2, tenantName: 'Espace Deux', role: 'agent', disabled: false },
    ]],
    ['revoque@x.fr', [{ id: 'u-revoque', tenantId: T1, tenantName: 'Espace Un', role: 'admin', disabled: true }]],
    ['autre@x.fr', [{ id: 'u-autre', tenantId: T2, tenantName: 'Espace Deux', role: 'admin', disabled: false }]],
    // Admin désactivé dans T1, agent actif dans T2 : sa preuve Google est bonne, aucun de ses comptes n'autorise.
    ['mixte@x.fr', [
      { id: 'u-mixte-1', tenantId: T1, tenantName: 'Espace Un', role: 'admin', disabled: true },
      { id: 'u-mixte-2', tenantId: T2, tenantName: 'Espace Deux', role: 'agent', disabled: false },
    ]],
  ]);
}

class FauxMagasin {
  readonly lignes = new Map<string, Ligne>();
  readonly codes = new Map<string, { autorisationId: string; challenge: string; redirectUri: string; utilise: boolean }>();
  lectures = 0;
  constructor(private readonly compteDe: (userId: string) => Compte | undefined) {}

  async creerAutorisation(e: NouvelleAutorisation): Promise<{ autorisationId: string }> {
    const id = randomUUID();
    this.lignes.set(id, {
      id, tenantId: e.tenantId, userId: e.userId, clientId: e.clientId, scopes: [...e.scopes], resource: e.resource,
      acces: null, refresh: null, precedent: null, revoque: false,
    });
    this.codes.set(e.code.empreinte, { autorisationId: id, challenge: e.code.challenge, redirectUri: e.code.redirectUri, utilise: false });
    return { autorisationId: id };
  }
  async consommerCode(empreinte: string): Promise<CodeConsomme | null> {
    this.lectures += 1;
    const c = this.codes.get(empreinte);
    if (!c || c.utilise) return null;
    c.utilise = true;
    const a = this.lignes.get(c.autorisationId)!;
    if (a.revoque) return null;
    return { autorisationId: a.id, tenantId: a.tenantId, clientId: a.clientId, challenge: c.challenge, redirectUri: c.redirectUri, scopes: a.scopes, resource: a.resource };
  }
  async poserJetons(id: string, j: NouveauxJetons & { refreshMaxLe: Date }): Promise<boolean> {
    const a = this.lignes.get(id);
    if (!a || a.revoque || a.refresh !== null) return false;
    a.acces = j.acces;
    a.refresh = j.refresh;
    return true;
  }
  private admin(a: Ligne): boolean {
    const c = this.compteDe(a.userId);
    return c !== undefined && c.role === 'admin' && !c.disabled;
  }
  async renouveler(empreinte: string, clientId: string, n: NouveauxJetons): Promise<'ok' | 'rejeu' | 'inconnu'> {
    this.lectures += 1;
    for (const a of this.lignes.values()) {
      if (a.refresh === empreinte && a.clientId === clientId && !a.revoque && this.admin(a)) {
        a.precedent = a.refresh;
        a.refresh = n.refresh;
        a.acces = n.acces;
        return 'ok';
      }
    }
    for (const a of this.lignes.values()) {
      if (a.precedent === empreinte) { a.revoque = true; return 'rejeu'; }
    }
    return 'inconnu';
  }
  async resoudreAcces(empreinte: string): Promise<AccesOauth | null> {
    const a = [...this.lignes.values()].find((l) => l.acces === empreinte);
    if (!a) return null;
    return { autorisationId: a.id, tenantId: a.tenantId, userId: a.userId, scopes: a.scopes, tenantStatus: 'active', valide: !a.revoque && this.admin(a) };
  }
  async revoquerParJeton(empreinte: string): Promise<boolean> {
    const a = [...this.lignes.values()].find((l) => !l.revoque && (l.acces === empreinte || l.refresh === empreinte));
    if (!a) return false;
    a.revoque = true;
    return true;
  }
  async lister(tenantId: string): Promise<AutorisationListee[]> {
    return [...this.lignes.values()].filter((a) => a.tenantId === tenantId && !a.revoque && a.refresh !== null).map((a) => ({
      id: a.id, clientId: a.clientId, userId: a.userId, email: 'admin@x.fr', nom: null, scopes: a.scopes,
      creeLe: '2026-10-03T10:00:00.000Z', dernierUsageLe: null,
    }));
  }
  async revoquer(tenantId: string, id: string): Promise<boolean> {
    const a = this.lignes.get(id);
    if (!a || a.tenantId !== tenantId || a.revoque) return false;
    a.revoque = true;
    return true;
  }
}

function monter(o: { publicApiUrl?: string } = {}) {
  const comptes = comptesDeDepart();
  const compteDe = (userId: string) => [...comptes.values()].flat().find((c) => c.id === userId);
  const magasin = new FauxMagasin(compteDe);
  const audits: Array<{ tenant: string; acteur: string | null; action: string; cible: string; detail: Record<string, unknown> }> = [];
  const crees: Array<{ nom: string; email: string; passwordHash: string | null }> = [];
  const connexions: string[] = [];
  const deps: OauthRouteDeps & OauthConsentementRouteDeps = {
    store: magasin,
    comptes: {
      getByEmail: async (email) => comptes.get(email) ?? [],
      createTenantWithAdmin: async (nom, admin) => {
        crees.push({ nom, email: admin.email, passwordHash: admin.passwordHash });
        const c = { id: randomUUID(), tenantId: randomUUID(), tenantName: nom, role: 'admin', disabled: false };
        comptes.set(admin.email, [c]);
        return { tenantId: c.tenantId, userId: c.id };
      },
      touchLastLogin: async (userId) => { connexions.push(userId); },
      getSessionUser: async (userId) => {
        const email = [...comptes.entries()].find(([, cs]) => cs.some((c) => c.id === userId))?.[0];
        const c = compteDe(userId);
        return email && c ? { tenantId: c.tenantId, role: c.role, email } : null;
      },
    },
    verifyGoogle: async (idToken): Promise<GoogleIdentity | null> => {
      if (idToken === 'NON-VERIFIE') return { email: 'admin@x.fr', name: null, emailVerified: false, sub: 'g0' };
      return idToken.startsWith('G:') ? { email: idToken.slice(2), name: 'Alice', emailVerified: true, sub: `g-${idToken}` } : null;
    },
    secret: SECRET,
    appUrl: `${APP}/`,
    audit: async (tenant, acteur, action, cible, detail = {}) => { audits.push({ tenant, acteur: acteur.userId, action, cible: cible.id, detail }); },
  };
  const mcp: DepsMcp = {
    estDesabonne: jamaisDesabonne,
    inbox: {
      ...mcpInerte,
      listConversations: async () => [],
      getConversationContext: async () => null,
      getDerniersMessages: async () => [],
      recordOutbound: async () => {},
    },
    repo: { getTenantPhoneNumberId: async () => null },
    sendReply: async () => 'wamid',
    takeControl: async () => {},
    contacts: {
      query: async () => [],
      findByPhone: async () => null,
      addTagsByPhoneReturningNew: async () => ({ touched: 0, added: [] }),
      analysesEtResumes: async () => new Map(),
    },
    listerMembres: async () => [],
    ...mcpWidgetsInertes,
  };
  const server = buildServer({
    queue: new FakeQueue(),
    publicApiUrl: o.publicApiUrl ?? BASE,
    auth: {
      users: { findIdentity: async () => null },
      secret: SECRET,
      getUserState: async (userId) => {
        const c = compteDe(userId);
        return c ? { role: c.role, disabled: c.disabled, tenantStatus: 'active' } : null;
      },
    },
    oauth: deps,
    oauthConsentement: deps,
    v1: {
      apiKeys: { findActiveByHash: async () => null, touchLastUsed: async () => {} },
      oauth: magasin,
      contacts: contactsV1Muets(),
      mcp,
    },
  });
  return { server, magasin, comptes, audits, crees, connexions };
}

type Serveur = ReturnType<typeof monter>['server'];

const json = { 'content-type': 'application/json' };
const session = (userId: string, tenantId: string, role: string) => signSession({ userId, tenantId, role }, SECRET);

/** La demande signée qu'`/oauth/authorize` porte jusqu'à la page de consentement. */
async function demander(server: Serveur, extra: Record<string, string> = {}): Promise<string> {
  const q = new URLSearchParams({
    response_type: 'code', client_id: CC, redirect_uri: RETOUR, code_challenge: DEFI, code_challenge_method: 'S256',
    state: 'etat-1', resource: `${BASE}/mcp`, ...extra,
  });
  const r = await server.inject({ method: 'GET', url: `/oauth/authorize?${q}` });
  expect(r.statusCode, r.body).toBe(302);
  const vers = new URL(String(r.headers.location));
  expect(`${vers.origin}${vers.pathname}`).toBe(`${APP}/autoriser`);
  return vers.searchParams.get('demande') ?? '';
}

const parGoogle = (server: Serveur, demande: string, idToken: string) =>
  server.inject({ method: 'POST', url: '/oauth/consentement/google', headers: json, payload: { demande, idToken } });
const autoriserParGoogle = (server: Serveur, demande: string, choix: string, tenantId: string) =>
  server.inject({ method: 'POST', url: '/oauth/consentement/autoriser', headers: json, payload: { demande, choix, tenantId } });
const echanger = (server: Serveur, champs: Record<string, string>) => server.inject({
  method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(champs).toString(),
});
const appelerMcp = (server: Serveur, jeton: string) => server.inject({
  method: 'POST', url: '/mcp', headers: { ...json, authorization: `Bearer ${jeton}` }, payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
});

/** Le code d'une autorisation donnée par Google dans T1, prêt à être échangé. */
async function codeAutorise(server: Serveur): Promise<string> {
  const demande = await demander(server);
  const { choix } = (await parGoogle(server, demande, 'G:admin@x.fr')).json<{ choix: string }>();
  const r = await autoriserParGoogle(server, demande, choix, T1);
  expect(r.statusCode, r.body).toBe(200);
  return new URL(r.json<{ adresse: string }>().adresse).searchParams.get('code') ?? '';
}
const echangerCode = (server: Serveur, code: string, autres: Record<string, string> = {}) =>
  echanger(server, { grant_type: 'authorization_code', code, redirect_uri: RETOUR, client_id: CC, code_verifier: VERIF, ...autres });

describe('les métadonnées', () => {
  it('celles de la ressource aux deux adresses, celles du serveur à la sienne, toutes sur PUBLIC_API_URL', async () => {
    const { server } = monter();
    for (const url of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const r = await server.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual(JSON.parse(JSON.stringify(metadonneesRessource(BASE))));
    }
    const as = await server.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(as.statusCode).toBe(200);
    expect(as.json()).toEqual(JSON.parse(JSON.stringify(metadonneesServeur(BASE))));
    await server.close();
  });
});

describe('/oauth/authorize', () => {
  it('une demande valide part vers la page de consentement, signée ; sans scope, les deux droits', async () => {
    const { server } = monter();
    expect(await verifyDemandeOauth(await demander(server), SECRET)).toEqual({
      clientId: CC, redirectUri: RETOUR, codeChallenge: DEFI, scopes: ['mcp:read', 'mcp:write'], state: 'etat-1', resource: `${BASE}/mcp`,
    });
    const lecture = await verifyDemandeOauth(await demander(server, { scope: 'mcp:read', redirect_uri: 'http://127.0.0.1:61000/callback' }), SECRET);
    expect(lecture?.scopes).toEqual(['mcp:read']);
    expect(lecture?.redirectUri).toBe('http://127.0.0.1:61000/callback');
    await server.close();
  });

  it('🔴 client inconnu ou adresse de retour non validée : 400 en texte, AUCUNE redirection', async () => {
    const { server } = monter();
    for (const [client, retour] of [
      ['https://evil.test/fiche', RETOUR],
      [CC, 'https://evil.test/callback'],
      [CC, 'http://localhost@evil.test/callback'],
      [CC, 'https://claude.ai/api/mcp/auth_callback'],
      [CLAUDE_AI, RETOUR],
    ] as const) {
      const q = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: retour, code_challenge: DEFI, code_challenge_method: 'S256', state: 's' });
      const r = await server.inject({ method: 'GET', url: `/oauth/authorize?${q}` });
      expect(r.statusCode, `${client} ${retour}`).toBe(400);
      expect(r.headers.location).toBeUndefined();
      expect(String(r.headers['content-type'])).toMatch(/^text\/plain/);
    }
    // Un paramètre manquant ou répété : pas de destinataire validé, pas de redirection non plus.
    for (const url of ['/oauth/authorize', `/oauth/authorize?client_id=${encodeURIComponent(CC)}&client_id=x&redirect_uri=${encodeURIComponent(RETOUR)}`]) {
      const r = await server.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(400);
      expect(r.headers.location).toBeUndefined();
    }
    await server.close();
  });

  it('toute autre erreur repart vers le client avec error, state et iss', async () => {
    const { server } = monter();
    const valide = { response_type: 'code', client_id: CC, redirect_uri: RETOUR, code_challenge: DEFI, code_challenge_method: 'S256', state: 'etat-1' };
    for (const [extra, erreur, state] of [
      [{ response_type: 'token' }, 'unsupported_response_type', 'etat-1'],
      [{ code_challenge_method: 'plain' }, 'invalid_request', 'etat-1'],
      [{ code_challenge: 'trop-court' }, 'invalid_request', 'etat-1'],
      [{ scope: 'mcp:read contacts:write' }, 'invalid_scope', 'etat-1'],
      [{ resource: `${BASE}/v1` }, 'invalid_target', 'etat-1'],
      [{ state: '' }, 'invalid_request', ''],
    ] as const) {
      const q = new URLSearchParams({ ...valide, ...extra });
      const r = await server.inject({ method: 'GET', url: `/oauth/authorize?${q}` });
      expect(r.statusCode, erreur).toBe(302);
      const vers = new URL(String(r.headers.location));
      expect(`${vers.origin}${vers.pathname}`).toBe(RETOUR);
      expect(vers.searchParams.get('error')).toBe(erreur);
      expect(vers.searchParams.get('state')).toBe(state);
      expect(vers.searchParams.get('iss')).toBe(BASE);
    }
    await server.close();
  });
});

describe('le parcours de Claude', () => {
  it('🔴 demande, Google, autoriser, échange, /mcp, renouvellement, puis le rejeu révoque tout', async () => {
    const { server, audits } = monter();
    const demande = await demander(server);

    const vue = await server.inject({ method: 'POST', url: '/oauth/consentement/demande', headers: json, payload: { demande } });
    expect(vue.json()).toEqual({ client: 'Claude Code', hoteDeRetour: 'localhost', droits: ['mcp:read', 'mcp:write'] });

    const g = await parGoogle(server, demande, 'G:admin@x.fr');
    expect(g.statusCode).toBe(200);
    const { choix, espaces, nouveau } = g.json<{ choix: string; nouveau: boolean; espaces: unknown[] }>();
    expect(nouveau).toBe(false);
    expect(espaces).toEqual([{ tenantId: T1, nom: 'Espace Un', admin: true }, { tenantId: T2, nom: 'Espace Deux', admin: false }]);

    const ok = await autoriserParGoogle(server, demande, choix, T1);
    expect(ok.statusCode).toBe(200);
    const retour = new URL(ok.json<{ adresse: string }>().adresse);
    expect(`${retour.origin}${retour.pathname}`).toBe(RETOUR);
    expect(retour.searchParams.get('state')).toBe('etat-1');
    expect(retour.searchParams.get('iss')).toBe(BASE);
    const code = retour.searchParams.get('code') ?? '';
    expect(code.startsWith(PREFIXE_CODE)).toBe(true);
    // Le journal porte le client et les droits, jamais le code ni une adresse.
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenant: T1, acteur: 'u-admin', action: 'oauth.autorise', detail: { client: 'Claude Code', scopes: ['mcp:read', 'mcp:write'] } });
    expect(JSON.stringify(audits)).not.toContain(code);

    const jetons = await echangerCode(server, code, { resource: `${BASE}/mcp` });
    expect(jetons.statusCode, jetons.body).toBe(200);
    expect(jetons.headers['cache-control']).toBe('no-store');
    const p1 = jetons.json<{ access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string }>();
    expect(p1).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp:read mcp:write' });
    expect(p1.access_token.startsWith('mbo_')).toBe(true);
    expect(p1.refresh_token.startsWith('mbr_')).toBe(true);
    expect((await appelerMcp(server, p1.access_token)).statusCode).toBe(200);

    // Un code ne sert qu'une fois.
    expect((await echangerCode(server, code)).json()).toMatchObject({ error: 'invalid_grant' });

    // Un renouvellement pour une AUTRE ressource est refusé avant de toucher au jeton, qui reste valable.
    const autre = await echanger(server, { grant_type: 'refresh_token', refresh_token: p1.refresh_token, client_id: CC, resource: 'https://evil.test/mcp' });
    expect(autre.json()).toMatchObject({ error: 'invalid_target' });

    const r2 = await echanger(server, { grant_type: 'refresh_token', refresh_token: p1.refresh_token, client_id: CC });
    expect(r2.statusCode, r2.body).toBe(200);
    const p2 = r2.json<{ access_token: string; refresh_token: string }>();
    expect((await appelerMcp(server, p2.access_token)).statusCode).toBe(200);
    expect((await appelerMcp(server, p1.access_token)).statusCode).toBe(401);

    // 🔴 L'ancien jeton de renouvellement présenté : le signe d'une fuite, toute l'autorisation tombe.
    expect((await echanger(server, { grant_type: 'refresh_token', refresh_token: p1.refresh_token, client_id: CC })).json()).toMatchObject({ error: 'invalid_grant' });
    expect((await appelerMcp(server, p2.access_token)).statusCode).toBe(401);
    expect((await echanger(server, { grant_type: 'refresh_token', refresh_token: p2.refresh_token, client_id: CC })).statusCode).toBe(400);
    await server.close();
  });

  it('🔴 la console : une session d’admin autorise sans Google ; un agent est refusé à la porte', async () => {
    const { server } = monter();
    const demande = await demander(server);
    const admin = await server.inject({
      method: 'POST', url: `/tenants/${T1}/oauth/autoriser`, headers: { ...json, authorization: `Bearer ${await session('u-admin', T1, 'admin')}` }, payload: { demande },
    });
    expect(admin.statusCode, admin.body).toBe(200);
    const code = new URL(admin.json<{ adresse: string }>().adresse).searchParams.get('code') ?? '';
    expect((await echangerCode(server, code)).statusCode).toBe(200);

    // 🔴 Un agent est refusé PAR LA GARDE DE MONTAGE (`g.admin`), sur les trois routes : le refus d'`autoriser` ne
    // couvrirait que la première, et la liste dit qui a ouvert l'espace à Claude.
    const agent = { ...json, authorization: `Bearer ${await session('u-agent', T2, 'agent')}` };
    for (const [method, url] of [
      ['POST', `/tenants/${T2}/oauth/autoriser`],
      ['GET', `/tenants/${T2}/oauth/autorisations`],
      ['DELETE', `/tenants/${T2}/oauth/autorisations/${randomUUID()}`],
    ] as const) {
      const r = await server.inject({ method, url, headers: agent, ...(method === 'POST' ? { payload: { demande } } : {}) });
      expect(r.statusCode, url).toBe(403);
      expect(r.json(), url).toEqual({ error: 'action réservée aux administrateurs' });
    }
    await server.close();
  });

  it('🔴 seul un admin autorise, et le rôle se relit AU CLIC, pas dans la preuve', async () => {
    const { server, magasin, comptes } = monter();
    const demande = await demander(server);
    const { choix } = (await parGoogle(server, demande, 'G:admin@x.fr')).json<{ choix: string }>();
    // Agent dans T2 : la preuve est bonne, le rôle ne l'est pas.
    const agent = await autoriserParGoogle(server, demande, choix, T2);
    expect(agent.statusCode).toBe(403);
    // Un espace où la personne n'a aucun compte.
    expect((await autoriserParGoogle(server, demande, choix, randomUUID())).statusCode).toBe(403);
    // Un compte admin DÉSACTIVÉ n'autorise rien, même si la personne a un autre compte actif.
    const mixte = await parGoogle(server, demande, 'G:mixte@x.fr');
    expect(mixte.json<{ espaces: unknown[] }>().espaces).toEqual([{ tenantId: T2, nom: 'Espace Deux', admin: false }]);
    expect((await autoriserParGoogle(server, demande, mixte.json<{ choix: string }>().choix, T1)).statusCode).toBe(403);
    // Admin de T1 quand la preuve a été signée, rétrogradé avant le clic.
    comptes.get('admin@x.fr')![0]!.role = 'agent';
    expect((await autoriserParGoogle(server, demande, choix, T1)).statusCode).toBe(403);
    expect(magasin.lignes.size).toBe(0);
    await server.close();
  });

  it('🔴 une preuve ne vaut que pour SA demande', async () => {
    const { server } = monter();
    const d1 = await demander(server);
    const d2 = await demander(server, { state: 'etat-2' });
    const { choix } = (await parGoogle(server, d1, 'G:admin@x.fr')).json<{ choix: string }>();
    expect((await autoriserParGoogle(server, d2, choix, T1)).statusCode).toBe(401);
    expect((await autoriserParGoogle(server, d1, 'pas-une-preuve', T1)).statusCode).toBe(401);
    await server.close();
  });

  it('une demande expirée (10 minutes) : 400 demande_expiree, jamais 401, y compris sur la route de la console', async () => {
    const { server } = monter();
    const demande = await demander(server);
    const { choix } = (await parGoogle(server, demande, 'G:admin@x.fr')).json<{ choix: string }>();
    const jeton = await session('u-admin', T1, 'admin');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      for (const [url, payload, entetes] of [
        ['/oauth/consentement/demande', { demande }, json],
        ['/oauth/consentement/google', { demande, idToken: 'G:admin@x.fr' }, json],
        ['/oauth/consentement/autoriser', { demande, choix, tenantId: T1 }, json],
        [`/tenants/${T1}/oauth/autoriser`, { demande }, { ...json, authorization: `Bearer ${jeton}` }],
      ] as const) {
        const r = await server.inject({ method: 'POST', url, headers: entetes, payload });
        expect(r.statusCode, url).toBe(400);
        expect(r.json(), url).toMatchObject({ code: 'demande_expiree' });
      }
    } finally {
      vi.useRealTimers();
    }
    await server.close();
  });

  it('🔴 une adresse Google inconnue : l’espace naît par le chemin de /auth/google, et l’autorisation aboutit', async () => {
    const { server, crees, connexions } = monter();
    const demande = await demander(server);
    const g = await parGoogle(server, demande, 'G:nouveau@x.fr');
    expect(g.statusCode).toBe(200);
    const corps = g.json<{ choix: string; nouveau: boolean; espaces: Array<{ tenantId: string; nom: string; admin: boolean }> }>();
    expect(corps.nouveau).toBe(true);
    expect(crees).toEqual([{ nom: 'Espace de Alice', email: 'nouveau@x.fr', passwordHash: null }]);
    expect(corps.espaces).toEqual([{ tenantId: expect.any(String), nom: 'Espace de Alice', admin: true }]);
    // Marqué connecté, comme par /auth/google : sinon l'admin neuf s'afficherait « en attente » sur la page Équipe.
    expect(connexions).toHaveLength(1);
    expect((await autoriserParGoogle(server, demande, corps.choix, corps.espaces[0]!.tenantId)).statusCode).toBe(200);
    await server.close();
  });

  it('compte révoqué : 403 ; jeton Google faux ou adresse non vérifiée : 401 ; aucun espace créé', async () => {
    const { server, crees } = monter();
    const demande = await demander(server);
    expect((await parGoogle(server, demande, 'G:revoque@x.fr')).statusCode).toBe(403);
    expect((await parGoogle(server, demande, 'FAUX')).statusCode).toBe(401);
    expect((await parGoogle(server, demande, 'NON-VERIFIE')).statusCode).toBe(401);
    expect(crees).toEqual([]);
    await server.close();
  });
});

describe('/oauth/token', () => {
  it('🔴 PKCE faux, autre adresse de retour, autre client : invalid_grant, et le code est brûlé quand même', async () => {
    const { server } = monter();
    const defauts: Array<Record<string, string>> = [
      { code_verifier: randomBytes(32).toString('base64url') },
      { redirect_uri: 'http://localhost:9999/callback' },
      { client_id: CLAUDE_AI },
    ];
    for (const autres of defauts) {
      const code = await codeAutorise(server);
      const r = await echangerCode(server, code, autres);
      expect(r.statusCode, JSON.stringify(autres)).toBe(400);
      expect(r.json()).toMatchObject({ error: 'invalid_grant' });
      // Le bon échange ensuite ne passe plus : un vérificateur ne se devine pas en plusieurs essais.
      expect((await echangerCode(server, code)).json()).toMatchObject({ error: 'invalid_grant' });
    }
    const code = await codeAutorise(server);
    expect((await echangerCode(server, code, { resource: `${BASE}/autre` })).json()).toMatchObject({ error: 'invalid_target' });
    await server.close();
  });

  it('les autres refus sont au format OAuth, en 400, sans cache, et une forme fausse n’atteint pas la base', async () => {
    const { server, magasin } = monter();
    for (const [champs, erreur] of [
      [{ grant_type: 'authorization_code', code: 'mbc_x', redirect_uri: RETOUR, client_id: 'https://evil.test/fiche', code_verifier: VERIF }, 'invalid_client'],
      [{ grant_type: 'authorization_code', code: 'mbc_x', redirect_uri: RETOUR, client_id: CC, code_verifier: VERIF }, 'invalid_grant'],
      [{ grant_type: 'authorization_code', code: 'mbc_x', client_id: CC }, 'invalid_request'],
      [{ grant_type: 'refresh_token', refresh_token: 'mbr_x', client_id: CC }, 'invalid_grant'],
      [{ grant_type: 'password', username: 'a', password: 'b' }, 'unsupported_grant_type'],
      [{ code: 'mbc_x' }, 'invalid_request'],
    ] as const) {
      const r = await echanger(server, champs);
      expect(r.statusCode, erreur).toBe(400);
      expect(r.json()).toMatchObject({ error: erreur });
      expect(r.headers['cache-control']).toBe('no-store');
    }
    expect(magasin.lectures).toBe(0);
    await server.close();
  });

  it('🔴 le même code présenté en boucle est freiné : 429 à la onzième présentation, avant la base', async () => {
    const { server, magasin } = monter();
    const code = nouveauJeton(PREFIXE_CODE).brut;
    for (let i = 0; i < 10; i++) expect((await echangerCode(server, code)).statusCode).toBe(400);
    const freine = await echangerCode(server, code);
    expect(freine.statusCode).toBe(429);
    expect(magasin.lectures).toBe(10);
    // Un autre code n'est pas concerné : le plafond est par code, jamais commun à tous les clients.
    expect((await echangerCode(server, nouveauJeton(PREFIXE_CODE).brut)).statusCode).toBe(400);
    await server.close();
  });
});

describe('la révocation', () => {
  it('🔴 /oauth/revoke : toujours 200, et le jeton du client révoque toute l’autorisation', async () => {
    const { server } = monter();
    const p = (await echangerCode(server, await codeAutorise(server))).json<{ access_token: string; refresh_token: string }>();
    for (const token of ['pas-un-jeton', `mbo_${'a'.repeat(43)}`]) {
      const r = await server.inject({ method: 'POST', url: '/oauth/revoke', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `token=${token}` });
      expect(r.statusCode).toBe(200);
    }
    expect((await appelerMcp(server, p.access_token)).statusCode).toBe(200);
    const r = await server.inject({ method: 'POST', url: '/oauth/revoke', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `token=${p.access_token}` });
    expect(r.statusCode).toBe(200);
    expect((await appelerMcp(server, p.access_token)).statusCode).toBe(401);
    expect((await echanger(server, { grant_type: 'refresh_token', refresh_token: p.refresh_token, client_id: CC })).statusCode).toBe(400);
    await server.close();
  });

  it('🔴 « Applications autorisées » : la liste de l’espace, et la révocation par un admin', async () => {
    const { server, audits } = monter();
    const p = (await echangerCode(server, await codeAutorise(server))).json<{ access_token: string }>();
    const entetes = { authorization: `Bearer ${await session('u-admin', T1, 'admin')}` };
    const liste = await server.inject({ method: 'GET', url: `/tenants/${T1}/oauth/autorisations`, headers: entetes });
    expect(liste.statusCode).toBe(200);
    const [a] = liste.json<{ autorisations: Array<{ id: string; client: string; email: string }> }>().autorisations;
    expect(a).toMatchObject({ client: 'Claude Code', email: 'admin@x.fr' });
    expect(JSON.stringify(liste.json())).not.toMatch(/mbo_|mbr_|hash/);

    const del = await server.inject({ method: 'DELETE', url: `/tenants/${T1}/oauth/autorisations/${a!.id}`, headers: entetes });
    expect(del.statusCode).toBe(200);
    expect(audits.at(-1)).toMatchObject({ tenant: T1, acteur: 'u-admin', action: 'oauth.revoque', cible: a!.id });
    expect((await appelerMcp(server, p.access_token)).statusCode).toBe(401);
    for (const id of [a!.id, 'pas-un-uuid']) {
      expect((await server.inject({ method: 'DELETE', url: `/tenants/${T1}/oauth/autorisations/${id}`, headers: entetes })).statusCode).toBe(404);
    }
    // 🔴 Une autorisation de T1 ne se révoque pas depuis T2, même par un admin de T2 : le magasin filtre sur l'espace.
    const p2 = (await echangerCode(server, await codeAutorise(server))).json<{ access_token: string }>();
    const [b] = (await server.inject({ method: 'GET', url: `/tenants/${T1}/oauth/autorisations`, headers: entetes })).json<{ autorisations: Array<{ id: string }> }>().autorisations;
    const autre = { authorization: `Bearer ${await session('u-autre', T2, 'admin')}` };
    expect((await server.inject({ method: 'DELETE', url: `/tenants/${T2}/oauth/autorisations/${b!.id}`, headers: autre })).statusCode).toBe(404);
    expect((await appelerMcp(server, p2.access_token)).statusCode).toBe(200);
    await server.close();
  });
});

describe('🔴 sans PUBLIC_API_URL', () => {
  it('tout le module rend 404, et la route de la console aussi : aucune demande n’a pu être émise', async () => {
    const { server } = monter({ publicApiUrl: '' });
    for (const [method, url] of [
      ['GET', '/.well-known/oauth-protected-resource'],
      ['GET', '/.well-known/oauth-protected-resource/mcp'],
      ['GET', '/.well-known/oauth-authorization-server'],
      ['GET', `/oauth/authorize?client_id=${encodeURIComponent(CC)}&redirect_uri=${encodeURIComponent(RETOUR)}`],
      ['POST', '/oauth/token'],
      ['POST', '/oauth/revoke'],
      ['POST', '/oauth/consentement/demande'],
      ['POST', '/oauth/consentement/google'],
      ['POST', '/oauth/consentement/autoriser'],
    ] as const) {
      const r = await server.inject({ method, url, headers: json, ...(method === 'POST' ? { payload: {} } : {}) });
      expect(r.statusCode, url).toBe(404);
    }
    const console_ = await server.inject({
      method: 'POST', url: `/tenants/${T1}/oauth/autoriser`, headers: { ...json, authorization: `Bearer ${await session('u-admin', T1, 'admin')}` }, payload: { demande: 'x' },
    });
    expect(console_.statusCode).toBe(404);
    await server.close();
  });
});
