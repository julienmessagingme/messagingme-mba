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
