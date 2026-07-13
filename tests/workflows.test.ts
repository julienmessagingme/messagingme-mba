import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { WorkflowRouteDeps } from '../src/http/workflows';
import type { WorkflowRow } from '../src/workflow/store.pg';

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

const sampleRow = (over: Partial<WorkflowRow> = {}): WorkflowRow => ({
  id: 'w1', tenantId: 't1', name: 'Onboarding', status: 'draft',
  graph: { nodes: [{ id: 'n1', type: 'template', position: { x: 0, y: 0 }, data: {} }], edges: [] },
  createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z', ...over,
});

function app(over: Partial<WorkflowRouteDeps> = {}) {
  const cap = { created: [] as Array<{ name: string; graph: unknown }>, updated: [] as Array<{ id: string; patch: unknown }>, deleted: [] as string[] };
  const deps: WorkflowRouteDeps = {
    createWorkflow: async (_t, name, graph) => { cap.created.push({ name, graph }); return { id: 'wNew' }; },
    listWorkflows: async () => [sampleRow()],
    getWorkflow: async (id) => (id === 'w1' ? sampleRow() : null),
    updateWorkflow: async (id, _t, patch) => { cap.updated.push({ id, patch }); return id === 'w1'; },
    deleteWorkflow: async (id) => { cap.deleted.push(id); return id === 'w1'; },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, workflows: deps }), cap };
}

const validGraph = {
  nodes: [{ id: 'n1', type: 'tag', position: { x: 0, y: 0 }, data: { tag: 'vip' } }, { id: 'n2', type: 'template', position: { x: 200, y: 0 }, data: { templateName: 'promo' } }],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
};

describe('routes workflows', () => {
  it('POST -> 201, graphe sanitisé passé au store', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: 'Onb', graph: validGraph } });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ id: string }>().id).toBe('wNew');
    expect(cap.created[0]!.name).toBe('Onb');
    await server.close();
  });

  it('POST sans graph -> 201 (démarre vide)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: 'Vide' } });
    expect(res.statusCode).toBe(201);
    expect(cap.created[0]!.graph).toEqual({ nodes: [], edges: [] });
    await server.close();
  });

  it('POST name vide -> 400 ; graphe invalide -> 400', async () => {
    const { server } = app();
    const noName = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: '', graph: validGraph } });
    const badGraph = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: 'X', graph: { nodes: [{ id: 'n1', type: 'tag', position: { x: 0, y: 0 } }], edges: [{ id: 'e', source: 'n1', target: 'ABSENT' }] } } });
    expect(noName.statusCode).toBe(400);
    expect(badGraph.statusCode).toBe(400);
    await server.close();
  });

  it('GET liste + GET un + 404', async () => {
    const { server } = app();
    const list = await server.inject({ method: 'GET', url: '/tenants/t1/workflows', ...h(adminTok) });
    expect(list.json<{ workflows: unknown[] }>().workflows).toHaveLength(1);
    const one = await server.inject({ method: 'GET', url: '/tenants/t1/workflows/w1', ...h(adminTok) });
    expect(one.statusCode).toBe(200);
    const miss = await server.inject({ method: 'GET', url: '/tenants/t1/workflows/nope', ...h(adminTok) });
    expect(miss.statusCode).toBe(404);
    await server.close();
  });

  it('PATCH graph -> 200 ; graphe invalide -> 400 ; status invalide -> 400', async () => {
    const { server, cap } = app();
    const ok = await server.inject({ method: 'PATCH', url: '/tenants/t1/workflows/w1', ...h(adminTok), payload: { graph: validGraph } });
    expect(ok.statusCode).toBe(200);
    expect(cap.updated[0]!.id).toBe('w1');
    const bad = await server.inject({ method: 'PATCH', url: '/tenants/t1/workflows/w1', ...h(adminTok), payload: { graph: { nodes: 'x', edges: [] } } });
    expect(bad.statusCode).toBe(400);
    const badStatus = await server.inject({ method: 'PATCH', url: '/tenants/t1/workflows/w1', ...h(adminTok), payload: { status: 'zzz' } });
    expect(badStatus.statusCode).toBe(400);
    await server.close();
  });

  it('DELETE -> 200 ; inconnu -> 404', async () => {
    const { server } = app();
    const ok = await server.inject({ method: 'DELETE', url: '/tenants/t1/workflows/w1', ...h(adminTok) });
    expect(ok.statusCode).toBe(200);
    const miss = await server.inject({ method: 'DELETE', url: '/tenants/t1/workflows/nope', ...h(adminTok) });
    expect(miss.statusCode).toBe(404);
    await server.close();
  });

  it('agent -> 403 sur écriture ; tenant croisé -> 403', async () => {
    const { server } = app();
    const agent = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(agentTok), payload: { name: 'X' } });
    expect(agent.statusCode).toBe(403);
    const cross = await server.inject({ method: 'GET', url: '/tenants/t1/workflows', ...h(otherTok) });
    expect(cross.statusCode).toBe(403);
    await server.close();
  });
});
