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

function app(fetchImpl: FetchLike, wabaId: string | null = 'waba1', getPublishedFlow?: (t: string, f: string) => Promise<boolean>) {
  return buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    templates: { templates: new MetaTemplateClient('tok', 'v23.0', fetchImpl), getWabaId: async () => wabaId, ...(getPublishedFlow ? { getPublishedFlow } : {}) },
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

  it('bouton URL dynamique ({{1}}) -> émet un example (exigé par Meta)', async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { id: 't', status: 'PENDING' } }]);
    const client = new MetaTemplateClient('tok', 'v23.0', fn);
    await client.create('waba1', {
      name: 'promo', category: 'MARKETING', language: 'fr', body: 'Voir',
      buttons: [{ type: 'URL', text: 'Suivre', url: 'https://x.fr/{{1}}' }],
    });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.components[1].buttons[0]).toEqual({ type: 'URL', text: 'Suivre', url: 'https://x.fr/{{1}}', example: ['https://x.fr/exemple'] });
  });
});

describe('MetaTemplateClient.list (pagination)', () => {
  it('suit paging.next et concatène toutes les pages', async () => {
    const { fn, calls } = makeFetch([
      { ok: true, status: 200, json: { data: [{ name: 'a', status: 'APPROVED', category: 'MARKETING', language: 'fr' }], paging: { next: 'https://graph.facebook.com/next?cursor=2' } } },
      { ok: true, status: 200, json: { data: [{ name: 'b', status: 'PENDING', category: 'UTILITY', language: 'fr' }] } },
    ]);
    const client = new MetaTemplateClient('tok', 'v23.0', fn);
    const all = await client.list('waba1');
    expect(all.map((t) => t.name)).toEqual(['a', 'b']);
    expect(calls[1]!.url).toBe('https://graph.facebook.com/next?cursor=2'); // 2e appel = curseur suivant
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

  it('GET liste : agent AUTORISÉ (200) — l inbox en a besoin pour envoyer un template hors fenêtre 24h', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: { data: [{ name: 'promo', status: 'APPROVED', category: 'MARKETING', language: 'fr' }] } }]);
    const a = app(fn);
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/templates', ...h(agentToken) });
    expect(res.statusCode).toBe(200); // NON-régression : agent lit la liste (create reste 403, testé ci-dessus)
    await a.close();
  });
});

describe('bouton FLOW (templates)', () => {
  it('create émet le composant FLOW {flow_id, navigate_screen:FORM, flow_action:navigate}', async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { id: 't', status: 'PENDING' } }]);
    const client = new MetaTemplateClient('tok', 'v23.0', fn);
    await client.create('waba1', { name: 'lead', category: 'MARKETING', language: 'fr', body: 'Bonjour', buttons: [{ type: 'FLOW', text: 'Répondre', flowId: 'flow123' }] });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.components[1].buttons[0]).toEqual({ type: 'FLOW', text: 'Répondre', flow_id: 'flow123', navigate_screen: 'FORM', flow_action: 'navigate' });
  });

  it('FLOW sans flowId -> 400', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: {} }]);
    const a = app(fn);
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', buttons: [{ type: 'FLOW', text: 'Go' }] } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('FLOW mélangé à un autre bouton -> 400 (exclusif)', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: {} }]);
    const a = app(fn);
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', buttons: [{ type: 'FLOW', text: 'Go', flowId: 'f1' }, { type: 'QUICK_REPLY', text: 'Autre' }] } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('FLOW non publié (getPublishedFlow=false) -> 400 AVANT Meta (fetch non appelé)', async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { id: 't', status: 'PENDING' } }]);
    const a = app(fn, 'waba1', async () => false);
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', buttons: [{ type: 'FLOW', text: 'Go', flowId: 'f1' }] } });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0); // pas d'appel Meta
    await a.close();
  });

  it('FLOW publié (getPublishedFlow=true) -> 201', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: { id: 't', status: 'PENDING' } }]);
    const a = app(fn, 'waba1', async () => true);
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', buttons: [{ type: 'FLOW', text: 'Go', flowId: 'f1' }] } });
    expect(res.statusCode).toBe(201);
    await a.close();
  });
});

describe('template CAROUSEL', () => {
  const card = (handle: string) => ({ headerHandle: handle, body: 'Carte', buttons: [{ type: 'QUICK_REPLY' as const, text: 'Voir' }] });

  it('create émet BODY + CAROUSEL avec cards (header IMAGE + header_handle + body + buttons)', async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { id: 't', status: 'PENDING' } }]);
    const client = new MetaTemplateClient('tok', 'v23.0', fn);
    await client.create('waba1', { name: 'promo', category: 'MARKETING', language: 'fr', body: 'Notre sélection', carousel: { cards: [card('H1'), card('H2')] } });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.components[0]).toMatchObject({ type: 'BODY', text: 'Notre sélection' });
    expect(body.components[1].type).toBe('CAROUSEL');
    expect(body.components[1].cards).toHaveLength(2);
    const c0 = body.components[1].cards[0].components;
    expect(c0[0]).toEqual({ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['H1'] } });
    expect(c0[1]).toEqual({ type: 'BODY', text: 'Carte' });
    expect(c0[2]).toMatchObject({ type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Voir' }] });
  });

  it('route : moins de 2 cartes -> 400', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: {} }]);
    const a = app(fn);
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', carousel: { cards: [card('H1')] } } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('route : plus de 10 cartes -> 400', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: {} }]);
    const a = app(fn);
    const cards = Array.from({ length: 11 }, (_, i) => card('H' + i));
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', carousel: { cards } } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('route : carte sans image (headerHandle) -> 400', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: {} }]);
    const a = app(fn);
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', carousel: { cards: [card('H1'), { body: 'x', buttons: [{ type: 'QUICK_REPLY', text: 'Voir' }] }] } } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('route : boutons divergents entre cartes -> 400', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: {} }]);
    const a = app(fn);
    const cards = [card('H1'), { headerHandle: 'H2', body: 'C', buttons: [{ type: 'URL' as const, text: 'Voir', url: 'https://x.fr' }] }];
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', carousel: { cards } } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('route : 2 cartes cohérentes -> 201', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: { id: 't', status: 'PENDING' } }]);
    const a = app(fn);
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', carousel: { cards: [card('H1'), card('H2')] } } });
    expect(res.statusCode).toBe(201);
    await a.close();
  });
});
