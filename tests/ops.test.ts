import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { OpsRouteDeps } from '../src/http/ops';

const OPS = 'ops-secret-token-of-at-least-32-bytes!!';

const OVERVIEW: Awaited<ReturnType<OpsRouteDeps['getTenantOverview']>> = [
  { id: 't1', name: 'Acme', createdAt: '2026-07-01T00:00:00.000Z', mbaEnabled: true, users: 2, contacts: 10, messages: 50, templatesUsed: 3, lastSendAt: null, phone: '+33 5 25 68 02 50', phoneStatus: 'CONNECTED', quality: 'GREEN' },
];

function app(opsToken = OPS, over: Partial<OpsRouteDeps> = {}) {
  const deps: OpsRouteDeps = {
    getTenantOverview: async () => OVERVIEW,
    getGlobalDaily: async () => [{ date: '2026-07-11', count: 5 }],
    getQueueLoad: async () => [{ queue: 'webhook', backlog: 0, active: 0, failed: 0 }],
    ...over,
  };
  return buildServer({ queue: new FakeQueue(), ops: deps, opsToken });
}
const withTok = (t: string) => ({ headers: { 'x-ops-token': t } });

describe('route /ops/overview', () => {
  it('token correct -> 200 { tenants, daily, queues, worker }', async () => {
    const server = app();
    const res = await server.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tenants: unknown[]; daily: unknown[]; queues: unknown[]; worker: unknown }>();
    expect(body.tenants).toHaveLength(1);
    expect(body.daily).toHaveLength(1);
    expect(body.queues).toHaveLength(1);
    // getWorkerHeartbeat est OPTIONNEL : non fourni par app() -> worker = null, la route ne casse pas.
    expect(body).toHaveProperty('worker');
    expect(body.worker).toBeNull();
    await server.close();
  });

  it('inclut le heartbeat worker quand le getter est fourni', async () => {
    const hb = { beatAt: '2026-07-24T10:00:00.000Z', bootedAt: '2026-07-24T09:00:00.000Z', instance: 'host:1', ageSeconds: 12 };
    const server = app(OPS, { getWorkerHeartbeat: async () => hb });
    const res = await server.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ worker: unknown }>().worker).toEqual(hb);
    await server.close();
  });

  it('sans header -> 401', async () => {
    const server = app();
    const res = await server.inject({ method: 'GET', url: '/ops/overview' });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('mauvais token -> 401', async () => {
    const server = app();
    const res = await server.inject({ method: 'GET', url: '/ops/overview', ...withTok('mauvais') });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('OPS_TOKEN vide -> 401 même avec un header (surface désactivée)', async () => {
    const server = app('');
    const res = await server.inject({ method: 'GET', url: '/ops/overview', ...withTok('') });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('un JWT admin ne donne PAS accès (autorité séparée du tenant)', async () => {
    const server = app();
    const jwt = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, 'secret');
    const res = await server.inject({ method: 'GET', url: '/ops/overview', headers: { authorization: `Bearer ${jwt}` } });
    expect(res.statusCode).toBe(401); // pas de x-ops-token
    await server.close();
  });

  it('lecture seule : aucune route de mutation (POST -> 404)', async () => {
    const server = app();
    const res = await server.inject({ method: 'POST', url: '/ops/overview', ...withTok(OPS) });
    expect(res.statusCode).toBe(404);
    await server.close();
  });
});

/**
 * Le solde prépayé d'un workspace, sur la surface d'exploitation.
 *
 * 🔴 LA RECHARGE EST LA PREMIÈRE ÉCRITURE MÉTIER DE `/ops`, et elle est ici pour une raison qui ne se
 * négocie pas : créditer le compte prépayé d'un client ne doit JAMAIS être accessible depuis un compte de la
 * console, sans quoi un client se rechargerait lui-même. L'autorité de `/ops` est séparée du JWT client,
 * c'est exactement celle qu'il faut.
 */
describe('solde prépayé sur /ops', () => {
  // Des identifiants qui ont la FORME d'un uuid : ils partent tels quels dans un `where id = $1` sur une
  // colonne `uuid`, et une valeur mal formée y fait LEVER Postgres au lieu de rendre zéro ligne.
  const T1 = '11111111-1111-4111-8111-111111111111';
  const INCONNU = '22222222-2222-4222-8222-222222222222';
  const deps = {
    soldeAgent: async (tenantId: string) => (tenantId === T1 ? { soldeMicroEur: 9_995_800, mouvements: [] } : null),
    rechargerAgent: async (tenantId: string, montant: number) => (tenantId === T1 ? 10_000_000 + montant : null),
  };
  const recharge = (montantMicroEur: unknown, note: unknown = 'virement du 27/08') => ({ montantMicroEur, note });

  it('lit le solde et son journal', async () => {
    const server = app(OPS, deps);
    const res = await server.inject({ method: 'GET', url: `/ops/credits/${T1}`, ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ soldeMicroEur: 9_995_800 });
    await server.close();
  });

  it('recharge, et rend le nouveau solde', async () => {
    const server = app(OPS, deps);
    const res = await server.inject({
      method: 'POST', url: `/ops/credits/${T1}`, ...withTok(OPS),
      payload: { montantMicroEur: 5_000_000, note: 'mise en service' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: T1, soldeMicroEur: 15_000_000 });
    await server.close();
  });

  it('🔴 SANS le jeton d exploitation, rien : ni lecture, ni recharge', async () => {
    // C'est toute la protection. Un client qui atteindrait cette route se créditerait lui-même.
    const server = app(OPS, deps);
    expect((await server.inject({ method: 'GET', url: `/ops/credits/${T1}` })).statusCode).toBe(401);
    expect((await server.inject({ method: 'GET', url: `/ops/credits/${T1}`, ...withTok('mauvais') })).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: `/ops/credits/${T1}`, ...withTok('mauvais'), payload: recharge(1) })).statusCode).toBe(401);
    await server.close();
  });

  it('🔴 un montant absurde est REFUSÉ, et rien n est écrit', async () => {
    // Il n'existe aucune route de débit : une virgule mal placée ne se rattrape pas, elle doit donc être
    // arrêtée à l'entrée.
    const recharges: number[] = [];
    const server = app(OPS, { ...deps, rechargerAgent: async (_t, m) => { recharges.push(m); return m; } });
    for (const montantMicroEur of [0, -5_000, 2_000_000_000, 'beaucoup', null, Number.NaN]) {
      const res = await server.inject({ method: 'POST', url: `/ops/credits/${T1}`, ...withTok(OPS), payload: recharge(montantMicroEur) });
      expect(res.statusCode, String(montantMicroEur)).toBe(400);
    }
    expect((await server.inject({ method: 'POST', url: `/ops/credits/${T1}`, ...withTok(OPS), payload: {} })).statusCode).toBe(400);
    expect(recharges).toEqual([]);
    await server.close();
  });

  it('🔴 une recharge SANS NOTE est refusée, et rien n est écrit', async () => {
    // Le jeton d'exploitation est partagé : il n'y a aucune identité d'opérateur à enregistrer, donc cette
    // phrase est la SEULE trace de qui a rechargé et pourquoi. Un mouvement d'argent sans explication ne se
    // justifie pas six mois plus tard.
    const recharges: number[] = [];
    const server = app(OPS, { ...deps, rechargerAgent: async (_t, m) => { recharges.push(m); return m; } });
    for (const note of ['', '   ', 'ok', 42, null]) {
      const res = await server.inject({ method: 'POST', url: `/ops/credits/${T1}`, ...withTok(OPS), payload: { montantMicroEur: 5_000_000, note } });
      expect(res.statusCode, String(note)).toBe(400);
    }
    // Et une note absente, pas seulement vide.
    expect((await server.inject({ method: 'POST', url: `/ops/credits/${T1}`, ...withTok(OPS), payload: { montantMicroEur: 5_000_000 } })).statusCode).toBe(400);
    expect(recharges).toEqual([]);
    await server.close();
  });

  it('🔴 un espace INCONNU rend 404, jamais un solde de zéro ni une 500', async () => {
    // Deux pièges d'un coup. En lecture, un « 0 » sur un identifiant mal tapé se lit « client à sec » et
    // appelle une recharge sur un espace qui n'existe pas. En écriture, la clé étrangère lèverait, donc un
    // 500 dont Cloudflare remplace le corps par sa page d'erreur, sur la seule route qui écrit de l'argent.
    const server = app(OPS, deps);
    expect((await server.inject({ method: 'GET', url: `/ops/credits/${INCONNU}`, ...withTok(OPS) })).statusCode).toBe(404);
    const res = await server.inject({ method: 'POST', url: `/ops/credits/${INCONNU}`, ...withTok(OPS), payload: recharge(5_000_000) });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('🔴 un identifiant qui n est pas un uuid rend 404, sans toucher la base', async () => {
    // Il partirait tel quel dans un `where id = $1` sur une colonne `uuid` : Postgres LÈVE (`22P02`), donc
    // 500. Une adresse tapée de travers doit rendre 404, pas une page d'incident.
    const vus: string[] = [];
    const server = app(OPS, {
      soldeAgent: async (t) => { vus.push(t); return { soldeMicroEur: 0, mouvements: [] }; },
      rechargerAgent: async (t) => { vus.push(t); return 1; },
    });
    expect((await server.inject({ method: 'GET', url: '/ops/credits/t1', ...withTok(OPS) })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: '/ops/credits/t1', ...withTok(OPS), payload: recharge(1000) })).statusCode).toBe(404);
    expect(vus).toEqual([]);
    await server.close();
  });

  it('une instance sans solde câblé rend 503, pas une erreur', async () => {
    const server = app(OPS, {});
    expect((await server.inject({ method: 'GET', url: `/ops/credits/${T1}`, ...withTok(OPS) })).statusCode).toBe(503);
    expect((await server.inject({ method: 'POST', url: `/ops/credits/${T1}`, ...withTok(OPS), payload: recharge(1000) })).statusCode).toBe(503);
    await server.close();
  });
});
