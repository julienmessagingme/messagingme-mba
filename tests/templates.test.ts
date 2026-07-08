import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { MetaTemplateClient } from '../src/meta/templates';
import type { FetchLike } from '../src/meta/templates';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';

const SECRET = 'test-secret';
let token = '';
let agentToken = '';
beforeAll(async () => {
  token = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentToken = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };

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

function app(fetchImpl: FetchLike, wabaId: string | null = 'waba1') {
  return buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    templates: { templates: new MetaTemplateClient('tok', 'v23.0', fetchImpl), getWabaId: async () => wabaId },
  });
}
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

describe('MetaTemplateClient.create (payload)', () => {
  it('construit BODY + example + BUTTONS', async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { id: 'tid', status: 'PENDING' } }]);
    const client = new MetaTemplateClient('tok', 'v23.0', fn);
    const res = await client.create('waba1', {
      name: 'promo', category: 'MARKETING', language: 'fr',
      body: 'Bonjour {{1}}', example: ['Julie'],
      buttons: [{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'URL', text: 'Voir', url: 'https://x.fr' }],
    });
    expect(res).toEqual({ id: 'tid', status: 'PENDING' });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.name).toBe('promo');
    expect(body.components[0]).toMatchObject({ type: 'BODY', text: 'Bonjour {{1}}', example: { body_text: [['Julie']] } });
    expect(body.components[1]).toMatchObject({ type: 'BUTTONS' });
    expect(body.components[1].buttons).toEqual([
      { type: 'QUICK_REPLY', text: 'Oui' },
      { type: 'URL', text: 'Voir', url: 'https://x.fr' },
    ]);
  });
});

describe('routes templates', () => {
  it('POST crée un template -> 201', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: { id: 'tid', status: 'PENDING' } }]);
    const a = app(fn);
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'promo', category: 'MARKETING', language: 'fr', body: 'Salut' } });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ status: string }>().status).toBe('PENDING');
    await a.close();
  });

  it('variable sans exemple -> 400', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: {} }]);
    const a = app(fn);
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'Bonjour {{1}}' } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('role agent -> 403', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: {} }]);
    const a = app(fn);
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(agentToken), payload: { name: 'p', category: 'UTILITY', language: 'fr', body: 'x' } });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('sans token -> 401', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: {} }]);
    const a = app(fn);
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', headers: { 'content-type': 'application/json' }, payload: {} });
    expect(res.statusCode).toBe(401);
    await a.close();
  });

  it('GET liste les templates', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: { data: [{ name: 'promo', status: 'APPROVED', category: 'MARKETING', language: 'fr' }] } }]);
    const a = app(fn);
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/templates', ...h(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ templates: Array<{ status: string }> }>().templates[0]?.status).toBe('APPROVED');
    await a.close();
  });
});
