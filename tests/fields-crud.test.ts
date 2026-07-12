import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { FieldsRouteDeps } from '../src/http/fields';
import type { UserFieldType } from '../src/crm/types';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

interface Cap { created: Array<{ key: string; label: string; type: UserFieldType }>; updated: Array<{ key: string; patch: { label?: string; type?: UserFieldType } }>; deleted: string[] }
function app(over: Partial<FieldsRouteDeps> = {}) {
  const cap: Cap = { created: [], updated: [], deleted: [] };
  const deps: FieldsRouteDeps = {
    listFields: async () => [{ key: 'ville', label: 'Ville', type: 'text' }],
    createField: async (_t, def) => { cap.created.push(def); return def.key === 'ville' ? 'exists' : 'created'; },
    updateField: async (_t, key, patch) => { cap.updated.push({ key, patch }); return key === 'ville'; },
    deleteField: async (_t, key) => { cap.deleted.push(key); return key === 'ville'; },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, fields: deps }), cap };
}

describe('routes user-fields (CRUD)', () => {
  it('GET admin -> 200 + liste', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/user-fields', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ fields: Array<{ key: string }> }>().fields[0]?.key).toBe('ville');
    await server.close();
  });

  it('GET agent -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/user-fields', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('POST create field -> 201 (clé dérivée du libellé)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/user-fields', ...h(adminTok), payload: { label: 'Code postal', type: 'text' } });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ key: string }>().key).toBe('code_postal'); // slug du libellé
    expect(cap.created[0]).toMatchObject({ key: 'code_postal', label: 'Code postal', type: 'text' });
    await server.close();
  });

  it('POST create field clé existante -> 409', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/user-fields', ...h(adminTok), payload: { label: 'Ville', type: 'text' } });
    expect(res.statusCode).toBe(409); // slug 'ville' déjà présent -> le mock renvoie 'exists'
    await server.close();
  });

  it('POST create field type invalide -> 400 ; agent -> 403', async () => {
    const { server } = app();
    const bad = await server.inject({ method: 'POST', url: '/tenants/t1/user-fields', ...h(adminTok), payload: { label: 'X', type: 'json' } });
    const agent = await server.inject({ method: 'POST', url: '/tenants/t1/user-fields', ...h(agentTok), payload: { label: 'X', type: 'text' } });
    expect(bad.statusCode).toBe(400);
    expect(agent.statusCode).toBe(403);
    await server.close();
  });

  it('PATCH label seul -> 200 (updateField appelé, la clé ne bouge pas)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/user-fields/ville', ...h(adminTok), payload: { label: 'Ville de résidence' } });
    expect(res.statusCode).toBe(200);
    expect(cap.updated).toEqual([{ key: 'ville', patch: { label: 'Ville de résidence' } }]);
    await server.close();
  });

  it('PATCH type invalide -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/user-fields/ville', ...h(adminTok), payload: { type: 'json' } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('PATCH sans label ni type -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/user-fields/ville', ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('PATCH clé inconnue -> 404 (updateField renvoie false)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/user-fields/ghost', ...h(adminTok), payload: { label: 'X' } });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('DELETE admin -> 200 ; clé inconnue -> 404', async () => {
    const { server } = app();
    const ok = await server.inject({ method: 'DELETE', url: '/tenants/t1/user-fields/ville', ...h(adminTok) });
    const ko = await server.inject({ method: 'DELETE', url: '/tenants/t1/user-fields/ghost', ...h(adminTok) });
    expect(ok.statusCode).toBe(200);
    expect(ko.statusCode).toBe(404);
    await server.close();
  });

  it('PATCH/DELETE agent -> 403', async () => {
    const { server, cap } = app();
    const p = await server.inject({ method: 'PATCH', url: '/tenants/t1/user-fields/ville', ...h(agentTok), payload: { label: 'X' } });
    const d = await server.inject({ method: 'DELETE', url: '/tenants/t1/user-fields/ville', ...h(agentTok) });
    expect(p.statusCode).toBe(403);
    expect(d.statusCode).toBe(403);
    expect(cap.updated).toHaveLength(0);
    expect(cap.deleted).toHaveLength(0);
    await server.close();
  });
});
