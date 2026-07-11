import { describe, it, expect, beforeAll } from 'vitest';
import { MetaFlowClient, FlowJsonInvalidError } from '../src/meta/flows';
import { MetaApiError } from '../src/meta/errors';
import { deriveElements } from '../src/meta/flow-json';
import type { FetchLike } from '../src/meta/templates';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { FlowRouteDeps } from '../src/http/flows';
import type { FlowRow } from '../src/flow/store.pg';

function makeFetch(responses: Array<{ ok: boolean; status: number; json: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return { ok: r.ok, status: r.status, json: async () => r.json } as Response;
  };
  return { fn, calls };
}

const ELEMENTS = deriveElements([
  { kind: 'field', label: 'Nom', type: 'text', required: true },
  { kind: 'field', label: 'Email', type: 'email', required: false },
]);

describe('MetaFlowClient.create', () => {
  it('POST /{waba}/flows : categories LEAD_GENERATION + flow_json en STRING -> {id, DRAFT}', async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { id: 'flow1', success: true } }]);
    const client = new MetaFlowClient('tok', 'v25.0', '7.2', fn);
    const res = await client.create('waba1', { name: 'Contact', elements: ELEMENTS, ref: 'ref1' });
    expect(res).toEqual({ id: 'flow1', status: 'DRAFT' });
    expect(calls[0]!.url).toContain('/waba1/flows');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.categories).toEqual(['LEAD_GENERATION']);
    expect(typeof body.flow_json).toBe('string'); // flow_json STRINGIFIÉ, pas objet imbriqué
    const fj = JSON.parse(body.flow_json);
    expect(fj.version).toBe('7.2');
    expect(fj.screens[0].layout.children[0].name).toBe('nom');
  });

  it('validation_errors non vide -> FlowJsonInvalidError', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: { id: 'bad', validation_errors: [{ message: 'INVALID_FLOW_JSON_VERSION' }] } }]);
    const client = new MetaFlowClient('tok', 'v25.0', '3.1', fn);
    await expect(client.create('waba1', { name: 'X', elements: ELEMENTS, ref: 'ref1' })).rejects.toBeInstanceOf(FlowJsonInvalidError);
  });

  it('HTTP non-ok -> MetaApiError', async () => {
    const { fn } = makeFetch([{ ok: false, status: 400, json: { error: { message: 'oops', code: 100 } } }]);
    const client = new MetaFlowClient('tok', 'v25.0', '7.2', fn);
    await expect(client.create('waba1', { name: 'X', elements: ELEMENTS, ref: 'ref1' })).rejects.toBeInstanceOf(MetaApiError);
  });
});

describe('MetaFlowClient.publish', () => {
  it('POST /{flow}/publish', async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { success: true } }]);
    const client = new MetaFlowClient('tok', 'v25.0', '7.2', fn);
    await client.publish('flow1');
    expect(calls[0]!.url).toContain('/flow1/publish');
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('erreur -> MetaApiError', async () => {
    const { fn } = makeFetch([{ ok: false, status: 400, json: { error: { message: 'no', code: 100 } } }]);
    const client = new MetaFlowClient('tok', 'v25.0', '7.2', fn);
    await expect(client.publish('flow1')).rejects.toBeInstanceOf(MetaApiError);
  });
});

describe('MetaFlowClient.list', () => {
  it('suit paging.next et concatène', async () => {
    const { fn, calls } = makeFetch([
      { ok: true, status: 200, json: { data: [{ id: 'a', name: 'A', status: 'PUBLISHED', categories: ['LEAD_GENERATION'] }], paging: { next: 'https://graph.facebook.com/next?c=2' } } },
      { ok: true, status: 200, json: { data: [{ id: 'b', name: 'B', status: 'DRAFT', categories: ['LEAD_GENERATION'] }] } },
    ]);
    const client = new MetaFlowClient('tok', 'v25.0', '7.2', fn);
    const all = await client.list('waba1');
    expect(all.map((f) => f.id)).toEqual(['a', 'b']);
    expect(calls[1]!.url).toBe('https://graph.facebook.com/next?c=2');
  });
});

// --- Routes flows (fakes + spy sur les appels Meta réels via un fetch fake) ---

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

interface Cap { inserted: Array<{ id: string; name: string }>; published: string[]; metaCalls: string[] }

function app(over: Partial<FlowRouteDeps> = {}, opts: { wabaId?: string | null; belongs?: boolean; metaOk?: boolean } = {}) {
  const cap: Cap = { inserted: [], published: [], metaCalls: [] };
  const fakeFetch: FetchLike = async (url) => {
    cap.metaCalls.push(String(url));
    const ok = opts.metaOk !== false;
    return { ok, status: ok ? 200 : 400, json: async () => (ok ? { id: 'flowNew', success: true } : { error: { message: 'x', code: 100 } }) } as Response;
  };
  const deps: FlowRouteDeps = {
    flows: new MetaFlowClient('tok', 'v25.0', '7.2', fakeFetch),
    getWabaId: async () => (opts.wabaId === undefined ? 'waba1' : opts.wabaId),
    insertFlow: async (_t, id, name) => { cap.inserted.push({ id, name }); },
    listFlows: async (): Promise<FlowRow[]> => [{ id: 'f1', tenantId: 't1', name: 'Contact', status: 'PUBLISHED', fields: [], elements: null, ref: null, mapping: null, createdAt: '2026-07-10T00:00:00.000Z', updatedAt: '2026-07-10T00:00:00.000Z' }],
    belongsTo: async () => opts.belongs !== false,
    markPublished: async (id) => { cap.published.push(id); return true; },
    // Mime la vraie ensureField : rejette un type qui n'est PAS un UserFieldType (text|number|date|boolean|url).
    // Sans normalisation, un champ Flow email/phone/textarea arriverait ici tel quel -> throw -> 500.
    ensureUserField: async (_t, _label, type) => {
      if (!['text', 'number', 'date', 'boolean', 'url'].includes(type)) throw new Error(`type de champ invalide: ${type}`);
    },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, flows: deps }), cap };
}

const validBody = { name: 'Contact', elements: [{ kind: 'field', label: 'Nom', type: 'text', required: true }, { kind: 'field', label: 'Email', type: 'email', required: false }] };

describe('routes flows — création', () => {
  it('POST admin -> 201, create Meta + insert appelés', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/flows', ...h(adminTok), payload: validBody });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ id: string; status: string }>()).toMatchObject({ id: 'flowNew', status: 'DRAFT' });
    expect(cap.inserted).toEqual([{ id: 'flowNew', name: 'Contact' }]);
    await server.close();
  });

  it('POST champ email en mapping par défaut -> 201 (type Flow normalisé en user field, pas de 500)', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'POST',
      url: '/tenants/t1/flows',
      ...h(adminTok),
      payload: { name: 'Contact', elements: [{ kind: 'field', label: 'Email', type: 'email', required: true }, { kind: 'field', label: 'Téléphone', type: 'phone', required: false }] },
    });
    expect(res.statusCode).toBe(201); // ensureUserField reçoit 'text', pas 'email'/'phone' -> pas d'erreur
    expect(cap.inserted).toHaveLength(1);
    await server.close();
  });

  it('POST name vide -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/flows', ...h(adminTok), payload: { name: '', elements: validBody.elements } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('POST aucun champ / type invalide -> 400', async () => {
    const { server } = app();
    const r1 = await server.inject({ method: 'POST', url: '/tenants/t1/flows', ...h(adminTok), payload: { name: 'X', elements: [] } });
    const r2 = await server.inject({ method: 'POST', url: '/tenants/t1/flows', ...h(adminTok), payload: { name: 'X', elements: [{ kind: 'field', label: 'A', type: 'checkbox', required: false }] } });
    const r3 = await server.inject({ method: 'POST', url: '/tenants/t1/flows', ...h(adminTok), payload: { name: 'X', elements: [{ kind: 'heading', text: 'Bonjour' }] } }); // texte seul, 0 champ -> rien à collecter
    expect(r1.statusCode).toBe(400);
    expect(r2.statusCode).toBe(400);
    expect(r3.statusCode).toBe(400);
    await server.close();
  });

  it('POST collision de clés -> 400 AVANT Meta (aucun appel Meta)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/flows', ...h(adminTok), payload: { name: 'X', elements: [{ kind: 'field', label: 'Nom', type: 'text', required: true }, { kind: 'field', label: ' nom ', type: 'text', required: false }] } });
    expect(res.statusCode).toBe(400);
    expect(cap.metaCalls).toHaveLength(0);
    await server.close();
  });

  it('POST aucun WABA -> 400', async () => {
    const { server } = app({}, { wabaId: null });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/flows', ...h(adminTok), payload: validBody });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('POST tenant mismatch -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/AUTRE/flows', ...h(adminTok), payload: validBody });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('POST agent -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/flows', ...h(agentTok), payload: validBody });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('POST Meta en erreur -> 422', async () => {
    const { server } = app({}, { metaOk: false });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/flows', ...h(adminTok), payload: validBody });
    expect(res.statusCode).toBe(422);
    await server.close();
  });
});

describe('routes flows — liste + publication', () => {
  it('GET sert le store (aucun appel Meta)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/flows', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ flows: FlowRow[] }>().flows[0]?.id).toBe('f1');
    expect(cap.metaCalls).toHaveLength(0);
    await server.close();
  });

  it('GET agent -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/flows', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('POST publish -> 200 (belongsTo OK -> Meta + markPublished)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/flows/f1/publish', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(cap.published).toEqual(['f1']);
    expect(cap.metaCalls.some((u) => u.includes('/f1/publish'))).toBe(true);
    await server.close();
  });

  it('POST publish belongsTo=false -> 404 ET aucun appel Meta', async () => {
    const { server, cap } = app({}, { belongs: false });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/flows/ghost/publish', ...h(adminTok) });
    expect(res.statusCode).toBe(404);
    expect(cap.metaCalls).toHaveLength(0);
    expect(cap.published).toHaveLength(0);
    await server.close();
  });

  it('POST publish agent -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/flows/f1/publish', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });
});
