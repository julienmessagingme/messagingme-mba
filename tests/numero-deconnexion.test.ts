import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { EmbeddedSignupRouteDeps } from '../src/http/embedded-signup';
import type { BilanDeconnexion, IssueDeconnexion } from '../src/account/deconnexion-numero';
import { metaInscriptionInerte, signupInerte } from './routes-inertes';
import { verrousEnMemoire } from './verrous';

/**
 * « Déconnecter le numéro » : les deux ROUTES (le déroulé a son fichier, `tests/deconnexion-numero.test.ts`).
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT : un geste irréversible (les conversations effacées, le numéro oublié) ne part que d'un
 * admin, que d'un corps qui le confirme explicitement, et une seule fois à la fois par espace ; un échec répond en 409
 * lisible avec ses étapes, jamais en 5xx (Cloudflare en remplacerait le corps).
 */
const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const BILAN: BilanDeconnexion = {
  phoneNumberId: 'pn-1', affiche: '+33 6 12 34 56 78', wabaId: 'waba-1', partage: false, jeton: 'propre',
  numeroFourni: null, conversations: 3, campagnesArretees: 1, mbaAllume: false, contactsSurLaListe: 0,
};
const REUSSI: IssueDeconnexion = {
  fait: true, conversations: 3, campagnesArretees: 1,
  etapes: [{ etape: 'conversations', etat: 'fait', detail: '3 effacée(s)' }, { etape: 'detachement', etat: 'fait', detail: null }],
};

function app(over: Partial<EmbeddedSignupRouteDeps> = {}) {
  const cap = { audit: [] as Array<{ action: string; detail: unknown }>, deconnectes: [] as string[] };
  const deps: EmbeddedSignupRouteDeps = {
    ...signupInerte,
    audit: async (_t, _acteur, action, _cible, detail) => { cap.audit.push({ action, detail }); },
    configId: 'cfg-123',
    appId: 'app-1',
    graphVersion: 'v25.0',
    meta: { ...metaInscriptionInerte, exchangeCode: async () => '', verifyWaba: async () => {}, getPhone: async () => ({ displayPhoneNumber: null, verifiedName: null, status: null }), subscribeApp: async () => {}, register: async () => {} },
    inscriptions: { linkTenant: async () => {}, lierCompteSansNumero: async () => {} },
    saveCredentials: async () => {},
    offrirCredit: async () => {},
    numeroDuTenant: async () => 'pn-1',
    etatNumero: async () => { throw new Error('non attendu dans ce test'); },
    demanderCode: async () => { throw new Error('non attendu dans ce test'); },
    verifierCode: async () => { throw new Error('non attendu dans ce test'); },
    enregistrerNumero: async () => { throw new Error('non attendu dans ce test'); },
    sauverPin: async () => { throw new Error('non attendu dans ce test'); },
    delierNumero: async () => { throw new Error('non attendu dans ce test'); },
    relierNumero: async () => { throw new Error('non attendu dans ce test'); },
    verrous: verrousEnMemoire(),
    bilanDeconnexion: async () => BILAN,
    deconnecterNumero: async (t) => { cap.deconnectes.push(t); return REUSSI; },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, embeddedSignup: deps }), cap };
}

const BILAN_URL = '/tenants/t1/numero/deconnexion';
const URL = '/tenants/t1/numero/deconnecter';

describe('GET /tenants/:tenantId/numero/deconnexion', () => {
  it('le bilan de l’espace du jeton, pour un admin', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'GET', url: BILAN_URL, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(BILAN);
    expect(cap.deconnectes).toEqual([]);
    await server.close();
  });

  it('aucun numéro : 404', async () => {
    const { server } = app({ bilanDeconnexion: async () => null });
    expect((await server.inject({ method: 'GET', url: BILAN_URL, ...h(adminTok) })).statusCode).toBe(404);
    await server.close();
  });

  it('un agent n’y a pas accès', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'GET', url: BILAN_URL, ...h(agentTok) })).statusCode).toBe(403);
    await server.close();
  });
});

describe('POST /tenants/:tenantId/numero/deconnecter', () => {
  it('🔴 confirmé par un admin : 200, ce qui est parti, et la trace sans le numéro affiché', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: { confirme: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deconnecte: true, conversations: 3, campagnesArretees: 1, etapes: REUSSI.etapes });
    expect(cap.deconnectes).toEqual(['t1']);
    expect(cap.audit).toEqual([{
      action: 'numero.deconnecte',
      detail: { phoneNumberId: 'pn-1', wabaId: 'waba-1', fait: true, etapes: ['conversations:fait', 'detachement:fait'] },
    }]);
    expect(JSON.stringify(cap.audit)).not.toContain('12 34');
    await server.close();
  });

  it.each([
    ['sans corps', undefined],
    ['corps vide', {}],
    ['confirme en texte', { confirme: 'true' }],
    ['confirme à false', { confirme: false }],
  ])('🔴 %s : 400, et rien ne se joue', async (_nom, payload) => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: URL, ...h(adminTok), ...(payload === undefined ? {} : { payload }) });
    expect(res.statusCode).toBe(400);
    expect(cap.deconnectes).toEqual([]);
    expect(cap.audit).toEqual([]);
    await server.close();
  });

  it('🔴 un agent ne déconnecte rien', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: URL, ...h(agentTok), payload: { confirme: true } });
    expect(res.statusCode).toBe(403);
    expect(cap.deconnectes).toEqual([]);
    await server.close();
  });

  it('aucun numéro : 404, rien au journal', async () => {
    const { server, cap } = app({ bilanDeconnexion: async () => null });
    const res = await server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: { confirme: true } });
    expect(res.statusCode).toBe(404);
    expect(cap.deconnectes).toEqual([]);
    expect(cap.audit).toEqual([]);
    await server.close();
  });

  it('🔴 un échec répond 409 (jamais 5xx), avec ce qu’il faut faire et les étapes jouées', async () => {
    const issue: IssueDeconnexion = { fait: false, raison: 'purge', etapes: [{ etape: 'conversations', etat: 'echec', detail: 'verrou' }] };
    const { server, cap } = app({ deconnecterNumero: async () => issue });
    const res = await server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: { confirme: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ cause: 'purge', etapes: issue.etapes });
    expect(res.json<{ error: string }>().error).toMatch(/toujours connecté.*Recommencez/);
    expect(cap.audit.map((a) => a.action)).toEqual(['numero.deconnecte']);
    await server.close();
  });

  it('🔴 un geste à la fois par espace : le second attend, puis passe une fois le premier fini', async () => {
    let liberer: () => void = () => {};
    const enCours = new Promise<void>((r) => { liberer = r; });
    const verrous = verrousEnMemoire();
    let appels = 0;
    const { server } = app({ verrous, deconnecterNumero: async () => { appels += 1; if (appels === 1) await enCours; return REUSSI; } });
    const premier = server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: { confirme: true } });
    // Laisser le premier prendre le verrou.
    await new Promise((r) => setTimeout(r, 20));
    const second = await server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: { confirme: true } });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ cause: 'en_cours' });
    liberer();
    expect((await premier).statusCode).toBe(200);
    expect(verrous.tenues()).toEqual([]);
    expect((await server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: { confirme: true } })).statusCode).toBe(200);
    expect(appels).toBe(2);
    await server.close();
  });

  it('le verrou est relâché même si le geste lève', async () => {
    const verrous = verrousEnMemoire();
    const { server } = app({ verrous, deconnecterNumero: async () => { throw new Error('panne de base'); } });
    const res = await server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: { confirme: true } });
    expect(res.statusCode).toBe(500);
    expect(verrous.tenues()).toEqual([]);
    await server.close();
  });
});
