import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { MeRouteDeps } from '../src/http/me';

const SECRET = 'test-secret';
let agentTok = '';
let otherTenantTok = '';
beforeAll(async () => {
  agentTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'agent' }, SECRET);
  otherTenantTok = await signSession({ userId: 'u9', tenantId: 't2', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

function app(over: Partial<MeRouteDeps> = {}) {
  const deps: MeRouteDeps = {
    getUser: async (userId) => (userId === 'u1' ? { email: 'julien@messagingme.fr', name: 'Julien Dumas', role: 'agent' } : null),
    ...over,
  };
  return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, me: deps });
}

describe('route me', () => {
  it('renvoie le profil de l\'utilisateur courant (depuis req.auth.userId)', async () => {
    const server = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/me', ...h(agentTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: 'julien@messagingme.fr', name: 'Julien Dumas', role: 'agent' });
    await server.close();
  });

  it('tenant croisé -> 403', async () => {
    const server = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/me', ...h(otherTenantTok) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('utilisateur inconnu -> 404', async () => {
    const server = app({ getUser: async () => null });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/me', ...h(agentTok) });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('sans token -> 401', async () => {
    const server = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/me' });
    expect(res.statusCode).toBe(401);
    await server.close();
  });
});
