import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { ApiKeysRouteDeps } from '../src/http/api-keys';
import type { ApiKeyRow } from '../src/auth/api-key-store.pg';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
let otherTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
  otherTok = await signSession({ userId: 'u3', tenantId: 't2', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

function app(over: Partial<ApiKeysRouteDeps> = {}) {
  const cap = { created: [] as Array<{ name: string; scopes: string[] }>, revoked: [] as string[] };
  const deps: ApiKeysRouteDeps = {
    createKey: async (_t, name, scopes) => { cap.created.push({ name, scopes }); return { id: 'k1', key: 'mba_secret_shown_once' }; },
    listKeys: async (): Promise<ApiKeyRow[]> => [{ id: 'k1', name: 'CI', scopes: ['contacts:write'], createdAt: '2026-07-17T00:00:00.000Z', lastUsedAt: null, revokedAt: null }],
    revokeKey: async (_t, id) => { cap.revoked.push(id); return id === 'k1'; },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, apiKeys: deps }), cap };
}

describe('routes api-keys (admin)', () => {
  it('POST -> 201 avec la clé EN CLAIR (montrée une fois)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/api-keys', ...h(adminTok), payload: { name: 'Intégration', scopes: ['contacts:write', 'sends:create'] } });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ id: string; key: string }>()).toMatchObject({ id: 'k1', key: 'mba_secret_shown_once' });
    expect(cap.created[0]).toEqual({ name: 'Intégration', scopes: ['contacts:write', 'sends:create'] });
    await server.close();
  });

  it('POST name vide -> 400 ; aucun scope -> 400 ; scope inconnu -> 400', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/api-keys', ...h(adminTok), payload: { name: '', scopes: ['contacts:write'] } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/api-keys', ...h(adminTok), payload: { name: 'X', scopes: [] } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/api-keys', ...h(adminTok), payload: { name: 'X', scopes: ['god:mode'] } })).statusCode).toBe(400);
    await server.close();
  });

  it('GET liste (sans hash)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/api-keys', ...h(adminTok) });
    const keys = res.json<{ keys: Array<Record<string, unknown>> }>().keys;
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toHaveProperty('keyHash');
    expect(keys[0]).not.toHaveProperty('key');
    await server.close();
  });

  it('DELETE -> 200 ; inconnue/déjà révoquée -> 404', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'DELETE', url: '/tenants/t1/api-keys/k1', ...h(adminTok) })).statusCode).toBe(200);
    expect((await server.inject({ method: 'DELETE', url: '/tenants/t1/api-keys/nope', ...h(adminTok) })).statusCode).toBe(404);
    await server.close();
  });

  it('agent -> 403 ; tenant croisé -> 403', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/api-keys', ...h(agentTok), payload: { name: 'X', scopes: ['contacts:write'] } })).statusCode).toBe(403);
    expect((await server.inject({ method: 'GET', url: '/tenants/t1/api-keys', ...h(otherTok) })).statusCode).toBe(403);
    await server.close();
  });
});
