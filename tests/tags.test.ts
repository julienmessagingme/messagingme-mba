import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { TagsRouteDeps } from '../src/http/tags';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

interface Cap { created: string[]; renamed: Array<{ from: string; to: string }>; removed: string[] }
function app(over: Partial<TagsRouteDeps> = {}) {
  const cap: Cap = { created: [], renamed: [], removed: [] };
  const deps: TagsRouteDeps = {
    listTags: async () => [{ tag: 'vip', count: 3 }, { tag: 'salon', count: 1 }],
    createTag: async (_t, name) => { cap.created.push(name); return true; },
    renameTag: async (_t, from, to) => { cap.renamed.push({ from, to }); return 2; },
    removeTag: async (_t, tag) => { cap.removed.push(tag); return 5; },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, tags: deps }), cap };
}

describe('routes tags', () => {
  it('GET admin -> 200 + liste', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/tags', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ tags: Array<{ tag: string }> }>().tags[0]?.tag).toBe('vip');
    await server.close();
  });

  it('GET agent -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/tags', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('POST create tag admin -> 201, createTag appelé', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/tags', ...h(adminTok), payload: { name: 'prospect' } });
    expect(res.statusCode).toBe(201);
    expect(cap.created).toEqual(['prospect']);
    await server.close();
  });

  it('POST create tag name vide -> 400 ; agent -> 403', async () => {
    const { server, cap } = app();
    const empty = await server.inject({ method: 'POST', url: '/tenants/t1/tags', ...h(adminTok), payload: { name: '  ' } });
    const agent = await server.inject({ method: 'POST', url: '/tenants/t1/tags', ...h(agentTok), payload: { name: 'x' } });
    expect(empty.statusCode).toBe(400);
    expect(agent.statusCode).toBe(403);
    expect(cap.created).toHaveLength(0);
    await server.close();
  });

  it('PATCH rename admin -> 200', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/tags', ...h(adminTok), payload: { from: 'vip', to: 'VIP' } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ renamed: number }>().renamed).toBe(2);
    expect(cap.renamed).toEqual([{ from: 'vip', to: 'VIP' }]);
    await server.close();
  });

  it('PATCH from/to vides ou identiques -> 400', async () => {
    const { server } = app();
    const r1 = await server.inject({ method: 'PATCH', url: '/tenants/t1/tags', ...h(adminTok), payload: { from: '', to: 'x' } });
    const r2 = await server.inject({ method: 'PATCH', url: '/tenants/t1/tags', ...h(adminTok), payload: { from: 'a', to: 'a' } });
    expect(r1.statusCode).toBe(400);
    expect(r2.statusCode).toBe(400);
    await server.close();
  });

  it('DELETE admin -> 200 (removeTag appelé)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'DELETE', url: '/tenants/t1/tags?tag=salon', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(cap.removed).toEqual(['salon']);
    await server.close();
  });

  it('DELETE sans tag -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'DELETE', url: '/tenants/t1/tags', ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('PATCH/DELETE agent -> 403', async () => {
    const { server, cap } = app();
    const p = await server.inject({ method: 'PATCH', url: '/tenants/t1/tags', ...h(agentTok), payload: { from: 'a', to: 'b' } });
    const d = await server.inject({ method: 'DELETE', url: '/tenants/t1/tags?tag=x', ...h(agentTok) });
    expect(p.statusCode).toBe(403);
    expect(d.statusCode).toBe(403);
    expect(cap.renamed).toHaveLength(0);
    expect(cap.removed).toHaveLength(0);
    await server.close();
  });
});
