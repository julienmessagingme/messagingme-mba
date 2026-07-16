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
  id: 'w1', tenantId: 't1', name: 'Onboarding',
  graph: { nodes: [{ id: 'n1', type: 'template', position: { x: 0, y: 0 }, data: {} }], edges: [] },
  createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z', ...over,
});

function app(over: Partial<WorkflowRouteDeps> = {}) {
  const cap = { created: [] as Array<{ name: string; graph: unknown }>, updated: [] as Array<{ id: string; patch: unknown }>, deleted: [] as string[], declared: [] as string[][] };
  const deps: WorkflowRouteDeps = {
    createWorkflow: async (_t, name, graph) => { cap.created.push({ name, graph }); return { id: 'wNew' }; },
    tenantCode: async () => 'k7m2p3',
    listWorkflows: async () => [sampleRow()],
    getWorkflow: async (id) => (id === 'w1' ? sampleRow() : null),
    updateWorkflow: async (id, _t, patch) => { cap.updated.push({ id, patch }); return id === 'w1'; },
    deleteWorkflow: async (id) => { cap.deleted.push(id); return id === 'w1'; },
    declareTags: async (_t, tags) => { cap.declared.push(tags); },
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

  it('POST/PATCH : graphe qui OUVRE sur un flow ou un message rapide -> 400 (fenêtre 24 h)', async () => {
    const { server, cap } = app();
    // tag -> flow en ouverture (la chaîne synchrone compte aussi comme ouverture).
    const flowEntry = {
      nodes: [
        { id: 'n1', type: 'tag', position: { x: 0, y: 0 }, data: { tag: 'vip' } },
        { id: 'n2', type: 'flow', position: { x: 200, y: 0 }, data: { flowId: 'fl1', flowName: 'RDV' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };
    const post = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: 'X', graph: flowEntry } });
    expect(post.statusCode).toBe(400);
    expect(post.json<{ error: string }>().error).toContain('template');
    const qmEntry = { nodes: [{ id: 'n1', type: 'quick_message', position: { x: 0, y: 0 }, data: { body: 'Salut', quickReplies: ['Oui'] } }], edges: [] };
    const patch = await server.inject({ method: 'PATCH', url: '/tenants/t1/workflows/w1', ...h(adminTok), payload: { graph: qmEntry } });
    expect(patch.statusCode).toBe(400);
    expect(cap.created).toEqual([]);
    expect(cap.updated).toEqual([]);
    await server.close();
  });

  it('POST : flow NON configuré (sans flowId) en ouverture -> 201 (le graphe reste enregistrable pendant la construction)', async () => {
    const { server } = app();
    const wip = { nodes: [{ id: 'n1', type: 'flow', position: { x: 0, y: 0 }, data: {} }], edges: [] };
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: 'WIP', graph: wip } });
    expect(res.statusCode).toBe(201);
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

  it('PATCH graph -> 200 ; graphe invalide -> 400 ; rien à modifier -> 400', async () => {
    const { server, cap } = app();
    const ok = await server.inject({ method: 'PATCH', url: '/tenants/t1/workflows/w1', ...h(adminTok), payload: { graph: validGraph } });
    expect(ok.statusCode).toBe(200);
    expect(cap.updated[0]!.id).toBe('w1');
    const bad = await server.inject({ method: 'PATCH', url: '/tenants/t1/workflows/w1', ...h(adminTok), payload: { graph: { nodes: 'x', edges: [] } } });
    expect(bad.statusCode).toBe(400);
    const empty = await server.inject({ method: 'PATCH', url: '/tenants/t1/workflows/w1', ...h(adminTok), payload: {} });
    expect(empty.statusCode).toBe(400);
    await server.close();
  });

  it('POST : chaque node reçoit un code public nod_<client>_<ulid>, dans la réponse ET le graphe persisté', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: 'Onb', graph: validGraph } });
    expect(res.statusCode).toBe(201);
    const g = res.json<{ graph: { nodes: Array<{ data: { code?: string } }> } }>().graph;
    for (const n of g.nodes) expect(n.data.code).toMatch(/^nod_k7m2p3_[0-9A-HJKMNP-TV-Z]{26}$/);
    const stored = cap.created[0]!.graph as { nodes: Array<{ data: { code?: string } }> };
    for (const n of stored.nodes) expect(n.data.code).toMatch(/^nod_k7m2p3_/); // mint AVANT le store
    await server.close();
  });

  it('PATCH graph : mint les codes manquants, CONSERVE un code valide du tenant', async () => {
    const { server } = app();
    const withCode = {
      nodes: [
        { id: 'n1', type: 'tag', position: { x: 0, y: 0 }, data: { tag: 'vip', code: 'nod_k7m2p3_0123456789ABCDEFGHJKMNPQRS' } },
        { id: 'n2', type: 'template', position: { x: 200, y: 0 }, data: { templateName: 'promo' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/workflows/w1', ...h(adminTok), payload: { graph: withCode } });
    expect(res.statusCode).toBe(200);
    const g = res.json<{ graph: { nodes: Array<{ data: { code?: string } }> } }>().graph;
    expect(g.nodes[0]!.data.code).toBe('nod_k7m2p3_0123456789ABCDEFGHJKMNPQRS'); // conservé (stabilité)
    expect(g.nodes[1]!.data.code).toMatch(/^nod_k7m2p3_[0-9A-HJKMNP-TV-Z]{26}$/); // minté
    await server.close();
  });

  it('POST déclare les tags des blocs « ajout de tag » (Contenus > Tags)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: 'Onb', graph: validGraph } });
    expect(res.statusCode).toBe(201);
    expect(cap.declared).toEqual([['vip']]); // le node tag 'vip', pas le node template
    await server.close();
  });

  it('PATCH graph déclare aussi les tags du graphe', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/workflows/w1', ...h(adminTok), payload: { graph: validGraph } });
    expect(res.statusCode).toBe(200);
    expect(cap.declared).toEqual([['vip']]);
    await server.close();
  });

  it('déclaration best-effort : un échec de declareTags ne casse pas la sauvegarde', async () => {
    const { server } = app({ declareTags: async () => { throw new Error('boom'); } });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: 'Onb', graph: validGraph } });
    expect(res.statusCode).toBe(201);
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
