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

type ListActive = (tenantId: string, name: string, language?: string) => Promise<Array<{ id: string; name: string; status: 'draft' | 'running' | 'paused'; templateLanguage: string }>>;
function app(fetchImpl: FetchLike, wabaId: string | null = 'waba1', getPublishedFlow?: (t: string, f: string) => Promise<boolean>, listActive?: ListActive) {
  return buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    templates: {
      templates: new MetaTemplateClient('tok', 'v23.0', fetchImpl),
      getWabaId: async () => wabaId,
      ...(getPublishedFlow ? { getPublishedFlow } : {}),
      ...(listActive ? { listActiveCampaignsForTemplate: listActive } : {}),
    },
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

describe('template HEADER + FOOTER', () => {
  it('create émet HEADER texte + FOOTER, ordre HEADER/BODY/FOOTER/BUTTONS', async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { id: 't', status: 'PENDING' } }]);
    const client = new MetaTemplateClient('tok', 'v23.0', fn);
    await client.create('waba1', { name: 'p', category: 'MARKETING', language: 'fr', header: { format: 'TEXT', text: 'Bonjour {{1}}', example: 'Marc' }, body: 'Corps', footer: 'À bientôt', buttons: [{ type: 'QUICK_REPLY', text: 'Oui' }] });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.components.map((c: { type: string }) => c.type)).toEqual(['HEADER', 'BODY', 'FOOTER', 'BUTTONS']);
    expect(body.components[0]).toMatchObject({ type: 'HEADER', format: 'TEXT', text: 'Bonjour {{1}}', example: { header_text: ['Marc'] } });
    expect(body.components[2]).toEqual({ type: 'FOOTER', text: 'À bientôt' });
  });

  it('create émet HEADER média (header_handle)', async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { id: 't', status: 'PENDING' } }]);
    const client = new MetaTemplateClient('tok', 'v23.0', fn);
    await client.create('waba1', { name: 'p', category: 'MARKETING', language: 'fr', header: { format: 'IMAGE', handle: 'H123' }, body: 'Corps' });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.components[0]).toEqual({ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['H123'] } });
  });

  it('route POST header texte + footer -> 201', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: { id: 't', status: 'PENDING' } }]);
    const a = app(fn);
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', header: { format: 'TEXT', text: 'Titre' }, footer: 'Merci' } });
    expect(res.statusCode).toBe(201);
    await a.close();
  });

  it('route POST header texte trop long / média sans handle / footer trop long -> 400', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: {} }]);
    const a = app(fn);
    const long = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', header: { format: 'TEXT', text: 'a'.repeat(70) } } });
    const noHandle = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', header: { format: 'IMAGE' } } });
    const footLong = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', footer: 'a'.repeat(70) } });
    // En-tête texte AVEC variable : rejeté en V1 (aucun chemin d'envoi ne sait fournir un param header -> Meta #132000).
    const headerVar = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', header: { format: 'TEXT', text: 'Salut {{1}}' } } });
    expect(long.statusCode).toBe(400);
    expect(noHandle.statusCode).toBe(400);
    expect(footLong.statusCode).toBe(400);
    expect(headerVar.statusCode).toBe(400);
    await a.close();
  });
});

describe('MetaTemplateClient.update / remove', () => {
  it('update POST /{id} : components remplacés, PAS de name/language (immuables)', async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { success: true } }]);
    const client = new MetaTemplateClient('tok', 'v23.0', fn);
    const res = await client.update('tid1', { category: 'MARKETING', body: 'Bonjour {{1}}', example: ['Marc'], buttons: [{ type: 'QUICK_REPLY', text: 'Oui' }] });
    expect(res).toEqual({ success: true });
    expect(calls[0]!.url).toContain('/tid1');
    expect(calls[0]!.url).not.toContain('message_templates'); // node template direct, pas l'edge WABA
    expect(calls[0]!.init.method).toBe('POST');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.name).toBeUndefined();
    expect(body.language).toBeUndefined();
    expect(body.category).toBe('MARKETING');
    expect(body.components[0]).toMatchObject({ type: 'BODY', text: 'Bonjour {{1}}', example: { body_text: [['Marc']] } });
    expect(body.components[1]).toMatchObject({ type: 'BUTTONS' });
  });

  it('remove DELETE /{waba}/message_templates?name=', async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { success: true } }]);
    const client = new MetaTemplateClient('tok', 'v23.0', fn);
    const res = await client.remove('waba1', 'promo_ete');
    expect(res).toEqual({ success: true });
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.url).toContain('/message_templates?name=promo_ete');
  });
});

describe('MetaTemplateClient.list (id + buttons + example + isCarousel + editable)', () => {
  it('projette id/buttons/example/isCarousel/editable depuis les components', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: { data: [
      { id: 'T1', name: 'simple', status: 'APPROVED', category: 'MARKETING', language: 'fr', components: [{ type: 'BODY', text: 'Bonjour {{1}}', example: { body_text: [['Marc']] } }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'URL', text: 'Voir', url: 'https://x.fr' }] }] },
      { id: 'T2', name: 'promo', status: 'APPROVED', category: 'MARKETING', language: 'fr', components: [{ type: 'BODY', text: 'Sélection' }, { type: 'CAROUSEL', cards: [] }] },
      { id: 'T3', name: 'entete', status: 'APPROVED', category: 'MARKETING', language: 'fr', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Avec image' }] },
      { id: 'T4', name: 'texte', status: 'APPROVED', category: 'MARKETING', language: 'fr', components: [{ type: 'HEADER', format: 'TEXT', text: 'Titre' }, { type: 'BODY', text: 'Corps' }, { type: 'FOOTER', text: 'À bientôt' }] },
    ] } }]);
    const client = new MetaTemplateClient('tok', 'v23.0', fn);
    const all = await client.list('waba1');
    expect(all[0]).toMatchObject({ id: 'T1', isCarousel: false, editable: true, example: ['Marc'] }); // BODY+BUTTONS -> éditable
    expect(all[0]!.buttons).toEqual([{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'URL', text: 'Voir', url: 'https://x.fr' }]);
    expect(all[1]).toMatchObject({ id: 'T2', isCarousel: true, editable: false }); // carousel -> non éditable
    expect(all[1]!.buttons).toBeUndefined();
    expect(all[2]).toMatchObject({ id: 'T3', isCarousel: false, editable: false }); // header MÉDIA -> non éditable (handle non récupérable)
    expect(all[3]).toMatchObject({ id: 'T4', editable: true, headerText: 'Titre', footer: 'À bientôt' }); // header TEXTE + footer -> éditable + projetés
  });
});

describe('routes templates — édition (PATCH)', () => {
  const listOne = (t: Record<string, unknown>) => ({ ok: true, status: 200, json: { data: [t] } });
  const approved = { id: 'TID', name: 'promo', status: 'APPROVED', category: 'MARKETING', language: 'fr', components: [{ type: 'BODY', text: 'Ancien' }] };

  it('PATCH simple -> 200 : l id est RÉSOLU côté serveur depuis le WABA (jamais fourni par le client)', async () => {
    const { fn, calls } = makeFetch([listOne(approved), { ok: true, status: 200, json: { success: true } }]);
    const a = app(fn);
    const res = await a.inject({ method: 'PATCH', url: '/tenants/t1/templates/promo', ...h(token), payload: { language: 'fr', category: 'MARKETING', body: 'Nouveau' } });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.url).toContain('message_templates'); // 1er appel = list (résolution id)
    expect(calls[1]!.url).toContain('/TID'); // 2e appel = update sur l id résolu
    expect(calls[1]!.url).not.toContain('message_templates');
    await a.close();
  });

  it('PATCH template introuvable dans le WABA -> 404', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: { data: [] } }]);
    const a = app(fn);
    const res = await a.inject({ method: 'PATCH', url: '/tenants/t1/templates/ghost', ...h(token), payload: { language: 'fr', category: 'MARKETING', body: 'x' } });
    expect(res.statusCode).toBe(404);
    await a.close();
  });

  it('PATCH template PENDING -> 409 (non éditable)', async () => {
    const { fn } = makeFetch([listOne({ ...approved, status: 'PENDING' })]);
    const a = app(fn);
    const res = await a.inject({ method: 'PATCH', url: '/tenants/t1/templates/promo', ...h(token), payload: { language: 'fr', category: 'MARKETING', body: 'x' } });
    expect(res.statusCode).toBe(409);
    await a.close();
  });

  it('PATCH template carousel -> 422 (édition non supportée)', async () => {
    const { fn } = makeFetch([listOne({ ...approved, components: [{ type: 'BODY', text: 'x' }, { type: 'CAROUSEL', cards: [] }] })]);
    const a = app(fn);
    const res = await a.inject({ method: 'PATCH', url: '/tenants/t1/templates/promo', ...h(token), payload: { language: 'fr', category: 'MARKETING', body: 'x' } });
    expect(res.statusCode).toBe(422);
    await a.close();
  });

  it('PATCH template avec HEADER MÉDIA -> 422 (handle non récupérable, anti perte de données)', async () => {
    const { fn, calls } = makeFetch([listOne({ ...approved, components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'x' }] })]);
    const a = app(fn);
    const res = await a.inject({ method: 'PATCH', url: '/tenants/t1/templates/promo', ...h(token), payload: { language: 'fr', category: 'MARKETING', body: 'x' } });
    expect(res.statusCode).toBe(422);
    expect(calls).toHaveLength(1); // seulement le list de résolution, PAS d'update Meta
    await a.close();
  });

  it('PATCH template à header TEXTE -> 200 (éditable), header régénéré', async () => {
    const { fn, calls } = makeFetch([listOne({ ...approved, components: [{ type: 'HEADER', format: 'TEXT', text: 'Ancien' }, { type: 'BODY', text: 'x' }] }), { ok: true, status: 200, json: { success: true } }]);
    const a = app(fn);
    const res = await a.inject({ method: 'PATCH', url: '/tenants/t1/templates/promo', ...h(token), payload: { language: 'fr', category: 'MARKETING', body: 'y', header: { format: 'TEXT', text: 'Nouveau' }, footer: 'Bas' } });
    expect(res.statusCode).toBe(200);
    const upd = JSON.parse(calls[1]!.init.body as string);
    expect(upd.components[0]).toMatchObject({ type: 'HEADER', format: 'TEXT', text: 'Nouveau' });
    expect(upd.components.some((c: { type: string }) => c.type === 'FOOTER')).toBe(true);
    await a.close();
  });

  it('PATCH bloqué si campagne active -> 409 (garde-fou D1) avec la liste des campagnes', async () => {
    const { fn } = makeFetch([listOne(approved), { ok: true, status: 200, json: { success: true } }]);
    const a = app(fn, 'waba1', undefined, async () => [{ id: 'c1', name: 'Promo été', status: 'running', templateLanguage: 'fr' }]);
    const res = await a.inject({ method: 'PATCH', url: '/tenants/t1/templates/promo', ...h(token), payload: { language: 'fr', category: 'MARKETING', body: 'x' } });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ campaigns: unknown[] }>().campaigns).toHaveLength(1);
    await a.close();
  });

  it('PATCH agent -> 403', async () => {
    const { fn } = makeFetch([listOne(approved)]);
    const a = app(fn);
    const res = await a.inject({ method: 'PATCH', url: '/tenants/t1/templates/promo', ...h(agentToken), payload: { language: 'fr', category: 'MARKETING', body: 'x' } });
    expect(res.statusCode).toBe(403);
    await a.close();
  });
});

describe('routes templates — suppression (DELETE)', () => {
  it('DELETE -> 200 : remove appelé (DELETE ?name=)', async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { success: true } }]);
    const a = app(fn);
    const res = await a.inject({ method: 'DELETE', url: '/tenants/t1/templates/promo', ...h(token) });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.url).toContain('name=promo');
    await a.close();
  });

  it('DELETE bloqué si campagne active -> 409, AUCUN appel Meta', async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { success: true } }]);
    const a = app(fn, 'waba1', undefined, async () => [{ id: 'c1', name: 'X', status: 'draft', templateLanguage: 'fr' }]);
    const res = await a.inject({ method: 'DELETE', url: '/tenants/t1/templates/promo', ...h(token) });
    expect(res.statusCode).toBe(409);
    expect(calls).toHaveLength(0);
    await a.close();
  });

  it('DELETE agent -> 403', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: { success: true } }]);
    const a = app(fn);
    const res = await a.inject({ method: 'DELETE', url: '/tenants/t1/templates/promo', ...h(agentToken) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });
});
