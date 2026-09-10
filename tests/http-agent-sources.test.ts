import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { AgentSourcesRouteDeps } from '../src/http/agent-sources';
import { LabelSourceDejaPris, type SourceVue } from '../src/agent/sources';

/**
 * Routes des SOURCES externes d'outils (lot L2).
 *
 * 🔴 CE QUE CES ROUTES ACCORDENT. Une source, c'est une adresse que le serveur ira appeler DEPUIS L'INTÉRIEUR
 * du réseau Docker du VPS (il voit l'admin NPM, les autres conteneurs, le service de métadonnées), et un
 * secret. Trois gardes se vérifient ici et nulle part ailleurs : l'adresse est refusée À L'ÉCRITURE si elle
 * n'est pas publique et en HTTPS ; le secret ne ressort jamais d'aucune réponse ; et supprimer une source
 * dont des outils ACTIFS dépendent est refusé, parce que la cascade rendrait un agent muet en silence.
 */
const SECRET = 'test-secret';
const SRC = '11111111-1111-4111-8111-111111111111';
const AUTRE = '22222222-2222-4222-8222-222222222222';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const SOURCE: SourceVue = {
  id: SRC, tenantId: 't1', kind: 'http', label: 'ERP', baseUrl: 'https://api.client.fr/v1',
  authKind: 'bearer', authHeaderName: null, aAuthentification: true, secretPublie: false,
  status: 'active', lastOkAt: null, lastError: null, outilsActifs: 0, agents: 0,
};

function app(over: Partial<SourceVue> = {}, epreuve?: AgentSourcesRouteDeps['eprouver']) {
  const cap = {
    creations: [] as Array<Record<string, unknown>>,
    patches: [] as Array<Record<string, unknown>>,
    suppressions: [] as string[],
    epreuves: [] as Array<{ id: string; chemin: string }>,
  };
  const source = { ...SOURCE, ...over };
  const deps: AgentSourcesRouteDeps = {
    lister: async () => [source],
    parId: async (tenant, id) => (tenant === 't1' && id === SRC ? source : null),
    creer: async (_t, input) => {
      cap.creations.push(input as unknown as Record<string, unknown>);
      if (input.label === 'deja') throw new LabelSourceDejaPris(input.label);
      return { ...source, label: input.label, baseUrl: input.baseUrl };
    },
    patch: async (_t, id, p) => { cap.patches.push(p); return id === SRC ? { ...source, ...p } : null; },
    supprimer: async (_t, id) => { cap.suppressions.push(id); return id === SRC; },
    eprouver: epreuve ?? (async (_t, id, chemin) => { cap.epreuves.push({ id, chemin }); return { ok: true, httpStatus: 200 }; }),
  };
  return { cap, srv: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, agentSources: deps }) };
}

const base = (tenant = 't1') => `/tenants/${tenant}/agent-sources`;
const corps = (over: Record<string, unknown> = {}) => ({
  label: 'ERP', baseUrl: 'https://api.client.fr/v1', authKind: 'bearer', authSecret: 'jeton-42', ...over,
});

describe('sources externes : déclarer', () => {
  it('crée une source et rend sa vue, SANS le secret', async () => {
    const { cap, srv } = app();
    const res = await srv.inject({ method: 'POST', url: base(), ...h(adminTok), payload: corps() });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('jeton-42');
    expect(res.json().source.aAuthentification).toBe(true);
    expect(cap.creations[0]).toMatchObject({ kind: 'http', label: 'ERP', authSecret: 'jeton-42' });
  });

  it('🔴 une adresse INTERNE ou en clair est refusée À L’ÉCRITURE, pas à l’appel', async () => {
    // La refuser à l'appel reviendrait à la découvrir en pleine conversation avec un contact.
    const { cap, srv } = app();
    for (const baseUrl of [
      'http://api.client.fr/v1', 'https://localhost/v1', 'http://127.0.0.1:81/api',
      'https://169.254.169.254/latest', 'http://172.18.0.1:8120/kb', 'https://mba-api.internal/v1', 'pas une url',
    ]) {
      const res = await srv.inject({ method: 'POST', url: base(), ...h(adminTok), payload: corps({ baseUrl }) });
      expect(res.statusCode, baseUrl).toBe(400);
    }
    expect(cap.creations).toEqual([]);
  });

  it('🔴 une authentification incohérente est refusée avant la base', async () => {
    // La contrainte de la 0088 refuserait de toute façon, mais en 500, dont Cloudflare remplace le corps.
    const { srv } = app();
    expect((await srv.inject({ method: 'POST', url: base(), ...h(adminTok), payload: corps({ authSecret: undefined }) })).statusCode).toBe(400);
    expect((await srv.inject({ method: 'POST', url: base(), ...h(adminTok), payload: corps({ authKind: 'header', authSecret: 'x' }) })).statusCode).toBe(400);
    expect((await srv.inject({ method: 'POST', url: base(), ...h(adminTok), payload: corps({ authKind: 'none', authSecret: undefined }) })).statusCode).toBe(201);
  });

  it('un libellé en double rend 409, pas 500', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'POST', url: base(), ...h(adminTok), payload: corps({ label: 'deja' }) })).statusCode).toBe(409);
  });
});

describe('sources externes : modifier', () => {
  it('🔴 un secret ABSENT du patch n’est pas transmis, donc pas effacé', async () => {
    // L'écran ne peut pas le renvoyer : il ne l'a jamais eu. Renommer une source ne doit pas couper
    // l'authentification du connecteur.
    const { cap, srv } = app();
    const res = await srv.inject({ method: 'PATCH', url: `${base()}/${SRC}`, ...h(adminTok), payload: { label: 'ERP prod' } });
    expect(res.statusCode).toBe(200);
    expect(cap.patches[0]).toEqual({ label: 'ERP prod' });
  });

  it('🔴 passer en « bearer » sans renvoyer le secret est ACCEPTÉ si la source en a déjà un', async () => {
    // La garde se calcule sur l'état EFFECTIF après écriture, jamais sur le seul corps : sinon elle ne
    // fermerait le trou que dans un sens, et refuserait un geste parfaitement légitime.
    const { srv } = app({ authKind: 'none', aAuthentification: true });
    expect((await srv.inject({ method: 'PATCH', url: `${base()}/${SRC}`, ...h(adminTok), payload: { authKind: 'bearer' } })).statusCode).toBe(200);
    // Mais une source SANS secret ne peut pas passer en bearer sans en fournir un.
    const sans = app({ authKind: 'none', aAuthentification: false });
    expect((await sans.srv.inject({ method: 'PATCH', url: `${base()}/${SRC}`, ...h(adminTok), payload: { authKind: 'bearer' } })).statusCode).toBe(400);
  });

  it('une adresse refusée l’est aussi en modification', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'PATCH', url: `${base()}/${SRC}`, ...h(adminTok), payload: { baseUrl: 'http://10.0.0.4/api' } })).statusCode).toBe(400);
  });
});

describe('sources externes : supprimer et éprouver', () => {
  it('🔴 supprimer une source dont des outils ACTIFS dépendent est REFUSÉ', async () => {
    // La cascade emporterait les outils sans bruit, et l'agent deviendrait muet sur ces gestes-là, en
    // production, sans que personne ne l'ait décidé.
    const { cap, srv } = app({ outilsActifs: 2 });
    const res = await srv.inject({ method: 'DELETE', url: `${base()}/${SRC}`, ...h(adminTok) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('2');
    expect(cap.suppressions).toEqual([]);
  });

  it('sans outil actif, la suppression passe', async () => {
    const { cap, srv } = app({ outilsActifs: 0 });
    expect((await srv.inject({ method: 'DELETE', url: `${base()}/${SRC}`, ...h(adminTok) })).statusCode).toBe(200);
    expect(cap.suppressions).toEqual([SRC]);
  });

  it('🔴 une épreuve QUI ÉCHOUE rend 200 avec `ok: false`, jamais une 5xx', async () => {
    // Cloudflare remplace le corps d'une 5xx par sa page : le client ne saurait même pas ce qui a échoué,
    // alors que c'est précisément l'information qu'il vient chercher.
    const { srv } = app({}, async () => ({ ok: false, httpStatus: 401, erreur: 'authentification refusée' }));
    const res = await srv.inject({ method: 'POST', url: `${base()}/${SRC}/epreuve`, ...h(adminTok), payload: { chemin: '/ping' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, httpStatus: 401 });
  });

  it('l’épreuve d’une source inconnue rend 404', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'POST', url: `${base()}/${AUTRE}/epreuve`, ...h(adminTok), payload: {} })).statusCode).toBe(404);
    expect((await srv.inject({ method: 'POST', url: `${base()}/pas-un-uuid/epreuve`, ...h(adminTok), payload: {} })).statusCode).toBe(404);
  });
});

describe('sources externes : qui a le droit', () => {
  it('🔴 réservé aux administrateurs, sur les cinq verbes', async () => {
    const { cap, srv } = app();
    expect((await srv.inject({ method: 'GET', url: base(), ...h(agentTok) })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'POST', url: base(), ...h(agentTok), payload: corps() })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'PATCH', url: `${base()}/${SRC}`, ...h(agentTok), payload: { label: 'x' } })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'DELETE', url: `${base()}/${SRC}`, ...h(agentTok) })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'POST', url: `${base()}/${SRC}/epreuve`, ...h(agentTok), payload: {} })).statusCode).toBe(403);
    expect(cap.creations).toEqual([]);
    expect(cap.suppressions).toEqual([]);
  });

  it('🔴 le tenant de l’URL ne peut pas dépasser celui du jeton', async () => {
    const { cap, srv } = app();
    expect((await srv.inject({ method: 'GET', url: base('t2'), ...h(adminTok) })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'POST', url: base('t2'), ...h(adminTok), payload: corps() })).statusCode).toBe(403);
    expect(cap.creations).toEqual([]);
  });

  it('sans jeton du tout, rien', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'GET', url: base() })).statusCode).toBe(401);
  });
});
