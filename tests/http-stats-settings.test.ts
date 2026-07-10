import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { StatsRouteDeps } from '../src/http/stats';
import type { SettingsRouteDeps } from '../src/http/settings';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

function app(over: { stats?: Partial<StatsRouteDeps>; settings?: Partial<SettingsRouteDeps> } = {}) {
  const stats: StatsRouteDeps = {
    getDashboard: async () => ({
      contacts: [{ date: '2026-07-09', count: 3 }],
      templates: { utility: [{ date: '2026-07-09', count: 1 }], marketing: [{ date: '2026-07-09', count: 2 }] },
      exchanged: [{ date: '2026-07-09', count: 5 }],
    }),
    ...over.stats,
  };
  const settings: SettingsRouteDeps = {
    getSettings: async () => ({ mbaEnabled: false }),
    setMbaEnabled: async () => {},
    ...over.settings,
  };
  return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, stats, settings });
}

describe('stats route', () => {
  it('GET /stats -> 3 séries', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats?days=30', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const b = res.json<{ contacts: unknown[]; templates: { utility: unknown[]; marketing: unknown[] }; exchanged: unknown[] }>();
    expect(b.contacts).toHaveLength(1);
    expect(b.templates.marketing[0]).toEqual({ date: '2026-07-09', count: 2 });
    expect(b.exchanged[0]).toEqual({ date: '2026-07-09', count: 5 });
    await a.close();
  });

  it('agent -> 403 sur les stats (dashboard réservé admin, Feature 2 RBAC)', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('tenant != token -> 403', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/AUTRE/stats', ...h(adminTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('sans token -> 401', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats' });
    expect(res.statusCode).toBe(401);
    await a.close();
  });
});

describe('settings route', () => {
  it('GET /settings admin -> mbaEnabled', async () => {
    const a = app({ settings: { getSettings: async () => ({ mbaEnabled: true }) } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/settings', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ mbaEnabled: boolean }>().mbaEnabled).toBe(true);
    await a.close();
  });

  it('GET /settings agent -> 403 (admin-only, Feature 2 RBAC)', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/settings', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('PUT /settings admin -> 200 + persiste', async () => {
    let saved: [string, boolean] | null = null;
    const a = app({ settings: { setMbaEnabled: async (t, e) => { saved = [t, e]; } } });
    const res = await a.inject({ method: 'PUT', url: '/tenants/t1/settings', ...h(adminTok), payload: { mbaEnabled: true } });
    expect(res.statusCode).toBe(200);
    expect(saved).toEqual(['t1', true]);
    await a.close();
  });

  it('PUT /settings agent -> 403 (admin-only)', async () => {
    const a = app();
    const res = await a.inject({ method: 'PUT', url: '/tenants/t1/settings', ...h(agentTok), payload: { mbaEnabled: true } });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('PUT /settings body invalide -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'PUT', url: '/tenants/t1/settings', ...h(adminTok), payload: { mbaEnabled: 'oui' } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });
});
