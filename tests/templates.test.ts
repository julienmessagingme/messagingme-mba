import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { MetaTemplateClient } from '../src/meta/templates';
import type { FetchLike } from '../src/meta/templates';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import { aucuneCampagneActive, modelesInertes } from './routes-inertes';
import type { CibleLien, LienTrace } from '../src/links/tracked-links.pg';

const SECRET = 'test-secret';
let token = '';
let agentToken = '';
beforeAll(async () => {
  token = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentToken = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };

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
      ...modelesInertes,
      meta: { templateClientForTenant: async () => new MetaTemplateClient('tok', 'v23.0', fetchImpl) },
      repo: { getTenantWabaId: async () => wabaId, listActiveCampaignsForTemplate: listActive ?? aucuneCampagneActive },
      ...(getPublishedFlow ? { getPublishedFlow } : {}),
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
    // Meta n'a pas rendu de catégorie : celle demandée.
    expect(res).toEqual({ id: 'tid', status: 'PENDING', category: 'MARKETING' });
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

  it('langue hors whitelist -> 400, aucun appel Meta', async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { id: 't', status: 'PENDING' } }]);
    const a = app(fn);
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'francais', body: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    await a.close();
  });

  it('langue valide hors fr (en_US) -> 201', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: { id: 't', status: 'PENDING' } }]);
    const a = app(fn);
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'en_US', body: 'x' } });
    expect(res.statusCode).toBe(201);
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

  it('route : MÊMES types de boutons mais texte ET url DIFFÉRENTS par carte -> 201 (le cas utile du carousel)', async () => {
    // Vérifié en live chez Meta (sonde 2026-08-11) : seule la disposition doit être identique. Chaque carte
    // pointe vers sa propre destination, sinon un carousel de 10 cartes renverrait 10 fois au même endroit.
    const { fn } = makeFetch([{ ok: true, status: 200, json: { id: 't', status: 'PENDING' } }]);
    const a = app(fn);
    const cards = [
      { headerHandle: 'H1', body: 'Carte une', buttons: [{ type: 'QUICK_REPLY' as const, text: 'Je viens' }, { type: 'URL' as const, text: 'Voir l événement', url: 'https://exemple.fr/un' }] },
      { headerHandle: 'H2', body: 'Carte deux', buttons: [{ type: 'QUICK_REPLY' as const, text: 'Ça m intéresse' }, { type: 'URL' as const, text: 'Détails', url: 'https://exemple.fr/deux' }] },
    ];
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', carousel: { cards } } });
    expect(res.statusCode).toBe(201);
    await a.close();
  });

  it('route : plus de 2 boutons sur une carte -> 400 (Meta refuse au-delà de 2)', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: {} }]);
    const a = app(fn);
    const trois = [{ type: 'QUICK_REPLY' as const, text: 'A' }, { type: 'QUICK_REPLY' as const, text: 'B' }, { type: 'URL' as const, text: 'C', url: 'https://x.fr' }];
    const cards = [{ headerHandle: 'H1', buttons: trois }, { headerHandle: 'H2', buttons: trois }];
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', carousel: { cards } } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('2 boutons');
    await a.close();
  });

  it('route : ORDRE des types différent entre cartes -> 400', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: {} }]);
    const a = app(fn);
    const cards = [
      { headerHandle: 'H1', buttons: [{ type: 'QUICK_REPLY' as const, text: 'A' }, { type: 'URL' as const, text: 'B', url: 'https://x.fr' }] },
      { headerHandle: 'H2', buttons: [{ type: 'URL' as const, text: 'B', url: 'https://x.fr' }, { type: 'QUICK_REPLY' as const, text: 'A' }] },
    ];
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', carousel: { cards } } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('route : URL de bouton sans schéma -> 400 nommant la carte et le bouton (plus le chemin JSON de Meta)', async () => {
    // Le vrai symptôme : Meta répondait « components[1]['cards'][1]['components'][2]['buttons'][1]['url']
    // is not a valid URI », illisible. On refuse avant l'appel, en désignant ce que l'opérateur a saisi.
    const { fn } = makeFetch([{ ok: true, status: 200, json: {} }]);
    const a = app(fn);
    const cards = [
      { headerHandle: 'H1', buttons: [{ type: 'URL' as const, text: 'Voir', url: 'https://exemple.fr/un' }] },
      { headerHandle: 'H2', buttons: [{ type: 'URL' as const, text: 'Voir', url: 'exemple.fr/deux' }] },
    ];
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', carousel: { cards } } });
    expect(res.statusCode).toBe(400);
    const err = res.json<{ error: string }>().error;
    expect(err).toContain('carte 2');
    expect(err).toContain('https://');
    await a.close();
  });

  it('route : URL de bouton TOP-LEVEL sans schéma -> 400 ; URL dynamique {{1}} -> acceptée', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: {} }]);
    const a = app(fn);
    const ko = await a.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', buttons: [{ type: 'URL', text: 'Voir', url: 'www.exemple.fr' }] } });
    expect(ko.statusCode).toBe(400);
    await a.close();

    const { fn: fn2 } = makeFetch([{ ok: true, status: 200, json: { id: 't', status: 'PENDING' } }]);
    const a2 = app(fn2);
    const ok = await a2.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: { name: 'p', category: 'MARKETING', language: 'fr', body: 'x', buttons: [{ type: 'URL', text: 'Voir', url: 'https://exemple.fr/p/{{1}}' }] } });
    expect(ok.statusCode).toBe(201); // l'URL dynamique reste une fonctionnalité supportée
    await a2.close();
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

  it('DELETE d\'un exemple Meta -> 422 avec le MESSAGE UTILISATEUR (pas « Invalid parameter »)', async () => {
    // Cas réel reproduit live : supprimer hello_world -> Meta refuse avec error_user_msg explicite.
    const { fn } = makeFetch([{
      ok: false, status: 400, json: { error: {
        message: 'Invalid parameter', code: 100, error_subcode: 2388094, type: 'OAuthException',
        error_user_title: 'Le modèle de message ne peut pas être modifié',
        error_user_msg: 'Les exemples de modèles ne peuvent pas être modifiés ou supprimés.',
      } },
    }]);
    const a = app(fn);
    const res = await a.inject({ method: 'DELETE', url: '/tenants/t1/templates/hello_world', ...h(token) });
    expect(res.statusCode).toBe(422);
    const msg = res.json<{ error: string }>().error;
    expect(msg).toContain('exemples de modèles ne peuvent pas');
    expect(msg).not.toContain('Invalid parameter');
    await a.close();
  });
});

describe('routes templates — indices variable->champ (paramHints)', () => {
  interface HintCap { saved: Array<{ name: string; language: string; hints: unknown }>; removed: string[] }
  function appHints(fetchImpl: FetchLike, cap: HintCap, getHints?: (t: string, n: string, l: string) => Promise<Array<{ position: number; source: unknown }>>) {
    return buildServer({
      queue: new FakeQueue(),
      auth: { users: noUsers, secret: SECRET },
      templates: {
        ...modelesInertes,
        meta: { templateClientForTenant: async () => new MetaTemplateClient('tok', 'v23.0', fetchImpl) },
        repo: { getTenantWabaId: async () => 'waba1', listActiveCampaignsForTemplate: aucuneCampagneActive },
        indices: {
          save: async (_t, name, language, hints) => { cap.saved.push({ name, language, hints }); },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          get: (getHints ?? (async () => [])) as any,
          removeByName: async (_t, name) => { cap.removed.push(name); },
        },
      },
    });
  }

  it('POST avec paramHints -> template créé + saveParamHints reçoit les indices parsés', async () => {
    const cap: HintCap = { saved: [], removed: [] };
    const { fn } = makeFetch([{ ok: true, status: 200, json: { id: 'tid', status: 'PENDING' } }]);
    const server = appHints(fn, cap);
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: {
      name: 'promo', language: 'fr', category: 'MARKETING', body: 'Bonjour {{1}}', example: ['Marie'],
      paramHints: [{ position: 1, source: { type: 'field', key: 'prenom' } }],
    } });
    expect(res.statusCode).toBe(201);
    expect(cap.saved).toEqual([{ name: 'promo', language: 'fr', hints: [{ position: 1, source: { type: 'field', key: 'prenom' } }] }]);
    await server.close();
  });

  it('POST avec paramHints MALFORMÉS -> 400, aucun appel Meta, aucun hint sauvé', async () => {
    const cap: HintCap = { saved: [], removed: [] };
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { id: 'tid', status: 'PENDING' } }]);
    const server = appHints(fn, cap);
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: {
      name: 'promo', language: 'fr', category: 'MARKETING', body: 'Bonjour {{1}}', example: ['Marie'],
      paramHints: [{ position: 0, source: { type: 'field', key: 'prenom' } }],
    } });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    expect(cap.saved).toHaveLength(0);
    await server.close();
  });

  it('GET param-hints -> renvoie les indices du store', async () => {
    const cap: HintCap = { saved: [], removed: [] };
    const { fn } = makeFetch([{ ok: true, status: 200, json: {} }]);
    const server = appHints(fn, cap, async () => [{ position: 1, source: { type: 'attribute', key: 'name' } }]);
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/templates/promo/param-hints?language=fr', ...h(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ hints: unknown[] }>().hints).toEqual([{ position: 1, source: { type: 'attribute', key: 'name' } }]);
    await server.close();
  });

  it('POST SANS paramHints -> saveParamHints PAS appelé (rien à effacer par mégarde)', async () => {
    const cap: HintCap = { saved: [], removed: [] };
    const { fn } = makeFetch([{ ok: true, status: 200, json: { id: 'tid', status: 'PENDING' } }]);
    const server = appHints(fn, cap);
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: {
      name: 'promo', language: 'fr', category: 'MARKETING', body: 'Bonjour {{1}}', example: ['Marie'],
    } });
    expect(res.statusCode).toBe(201);
    expect(cap.saved).toHaveLength(0); // clé absente = on ne touche pas aux indices
    await server.close();
  });

  it('PATCH SANS paramHints -> n\'EFFACE PAS les indices existants (clé absente = on ne touche pas)', async () => {
    const cap: HintCap = { saved: [], removed: [] };
    // 1) list (résout l'id + éditable BODY-only), 2) update.
    const { fn } = makeFetch([
      { ok: true, status: 200, json: { data: [{ id: 'T1', name: 'promo', status: 'APPROVED', category: 'MARKETING', language: 'fr', components: [{ type: 'BODY', text: 'Bonjour {{1}}' }] }] } },
      { ok: true, status: 200, json: { id: 'T1', success: true } },
    ]);
    const server = appHints(fn, cap);
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/templates/promo', ...h(token), payload: {
      language: 'fr', category: 'MARKETING', body: 'Bonjour {{1}} !', example: ['Marie'],
    } });
    expect(res.statusCode).toBe(200);
    expect(cap.saved).toHaveLength(0); // aucun paramHints -> save NON appelé -> indices préservés
    await server.close();
  });
});

describe('MetaTemplateClient.list — relecture des cartes de CAROUSEL (pour l envoi)', () => {
  const carouselTpl = (cards: unknown[]) => ({
    ok: true, status: 200,
    json: { data: [{ id: 'C1', name: 'promo', status: 'APPROVED', category: 'MARKETING', language: 'fr', components: [{ type: 'BODY', text: 'Sélection' }, { type: 'CAROUSEL', cards }] }] },
  });

  it('projette média, corps et boutons de chaque carte', async () => {
    const { fn } = makeFetch([carouselTpl([
      { components: [
        { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://scontent.whatsapp.net/a.jpg?oe=1'] } },
        { type: 'BODY', text: 'Carte une' },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'URL', text: 'Voir', url: 'https://x.fr' }] },
      ] },
      { components: [{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://scontent.whatsapp.net/b.jpg'] } }] },
    ])]);
    const all = await new MetaTemplateClient('tok', 'v23.0', fn).list('waba1');
    expect(all[0]!.isCarousel).toBe(true);
    expect(all[0]!.carousel!.cards).toHaveLength(2);
    expect(all[0]!.carousel!.cards[0]).toMatchObject({ mediaUrl: 'https://scontent.whatsapp.net/a.jpg?oe=1', body: 'Carte une' });
    expect(all[0]!.carousel!.cards[0]!.buttons).toEqual([{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'URL', text: 'Voir', url: 'https://x.fr' }]);
    expect(all[0]!.carousel!.cards[1]).toEqual({ mediaUrl: 'https://scontent.whatsapp.net/b.jpg' });
  });

  it("un handle de création (4::...) n'est PAS une URL d'envoi -> carte sans média (l'envoi refusera)", async () => {
    const { fn } = makeFetch([carouselTpl([
      { components: [{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::aW1hZ2UvanBlZw=='] } }] },
    ])]);
    const all = await new MetaTemplateClient('tok', 'v23.0', fn).list('waba1');
    expect(all[0]!.carousel!.cards[0]!.mediaUrl).toBeUndefined();
  });

  it('carte VIDEO -> mediaFormat VIDEO ; cards vide -> carousel vide, isCarousel reste true', async () => {
    const { fn } = makeFetch([carouselTpl([
      { components: [{ type: 'HEADER', format: 'VIDEO', example: { header_handle: ['https://cdn.fr/v.mp4'] } }] },
    ])]);
    const all = await new MetaTemplateClient('tok', 'v23.0', fn).list('waba1');
    expect(all[0]!.carousel!.cards[0]!.mediaFormat).toBe('VIDEO');

    const { fn: fn2 } = makeFetch([carouselTpl([])]);
    const empty = await new MetaTemplateClient('tok', 'v23.0', fn2).list('waba1');
    expect(empty[0]!.isCarousel).toBe(true);
    expect(empty[0]!.carousel!.cards).toEqual([]);
  });

  it('template SANS carousel -> carousel undefined, isCarousel false (non-régression)', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: { data: [{ id: 'S1', name: 'simple', status: 'APPROVED', category: 'MARKETING', language: 'fr', components: [{ type: 'BODY', text: 'Bonjour' }] }] } }]);
    const all = await new MetaTemplateClient('tok', 'v23.0', fn).list('waba1');
    expect(all[0]!.isCarousel).toBe(false);
    expect(all[0]!.carousel).toBeUndefined();
  });
});

describe('traçage des liens : la route substitue à la soumission et ré-habille à la relecture', () => {
  /** Un faux traçage qui note l'ORDRE des opérations : c'est lui qui compte, pas seulement le résultat. */
  function tracage() {
    const journal: string[] = [];
    const destinations = new Map<string, string>();
    return {
      journal,
      dep: {
        allocate: async (_t: string, cible: { buttonIndex: number }, destination: string) => {
          journal.push(`allocate:${cible.buttonIndex}:${destination}`);
          const code = `code${cible.buttonIndex}aaaaaaa`;
          destinations.set(`https://mba.messagingme.app/r/${code}`, destination);
          return code;
        },
        liens: {
          confirm: async (_t: string, codes: readonly string[]) => { journal.push(`confirm:${codes.join(',')}`); },
          deconfirmer: async (_t: string, codes: readonly string[]) => { journal.push(`deconfirmer:${codes.join(',')}`); },
          listByTemplates: async () => [],
        },
        lienDe: (code: string) => `https://mba.messagingme.app/r/${code}`,
        destinations: async () => destinations,
      },
    };
  }

  const corps = {
    name: 'promo_lien', language: 'fr', category: 'MARKETING', body: 'Bonjour',
    buttons: [{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'URL', text: 'Voir le site', url: 'https://client.fr/promo' }],
  };

  it('🔴 META reçoit NOTRE lien, et la destination est enregistrée AVANT l’appel', async () => {
    // L'ordre n'est pas un détail : soumettre d'abord laisserait, en cas de panne entre les deux, un template
    // approuvé pointant un code inexistant — un lien mort dans des messages déjà livrés, irréparable.
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { id: 'tpl-1', status: 'PENDING' } }]);
    const t = tracage();
    const server = buildServer({
      queue: new FakeQueue(),
      auth: { users: noUsers, secret: SECRET },
      templates: { ...modelesInertes, meta: { templateClientForTenant: async () => new MetaTemplateClient('tok', 'v23.0', fn) }, repo: { getTenantWabaId: async () => 'waba1', listActiveCampaignsForTemplate: aucuneCampagneActive }, tracking: t.dep },
    });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: corps });
    expect(res.statusCode).toBe(201);

    const envoye = JSON.parse(String(calls[0]!.init.body)) as { components: Array<{ type: string; buttons?: Array<{ type: string; url?: string }> }> };
    const boutons = envoye.components.find((c) => c.type === 'BUTTONS')!.buttons!;
    expect(boutons[1]!.url).toBe('https://mba.messagingme.app/r/code1aaaaaaa');
    expect(boutons[0]).toEqual({ type: 'QUICK_REPLY', text: 'Oui' }); // le bouton de choix reste intact

    // Réservation AVANT la soumission, confirmation APRÈS.
    expect(t.journal).toEqual(['allocate:1:https://client.fr/promo', 'confirm:code1aaaaaaa']);
    await server.close();
  });

  it('🔴 Meta REFUSE -> aucune confirmation (sinon la mesure proposerait une case qui ment)', async () => {
    const { fn } = makeFetch([{ ok: false, status: 400, json: { error: { message: 'Invalid parameter' } } }]);
    const t = tracage();
    const server = buildServer({
      queue: new FakeQueue(),
      auth: { users: noUsers, secret: SECRET },
      templates: { ...modelesInertes, meta: { templateClientForTenant: async () => new MetaTemplateClient('tok', 'v23.0', fn) }, repo: { getTenantWabaId: async () => 'waba1', listActiveCampaignsForTemplate: aucuneCampagneActive }, tracking: t.dep },
    });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: corps });
    expect(res.statusCode).toBe(422);
    expect(t.journal).toEqual(['allocate:1:https://client.fr/promo']); // réservé, jamais confirmé
    await server.close();
  });

  it('🔴 une panne du traçage soumet le template avec le lien SAISI, elle ne le fait pas échouer', async () => {
    // Un template non mesuré vaut mieux qu'un template refusé, ou pire, approuvé avec une adresse qu'on ne
    // saurait pas servir.
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { id: 'tpl-1', status: 'PENDING' } }]);
    const server = buildServer({
      queue: new FakeQueue(),
      auth: { users: noUsers, secret: SECRET },
      templates: {
        ...modelesInertes,
        meta: { templateClientForTenant: async () => new MetaTemplateClient('tok', 'v23.0', fn) },
        repo: { getTenantWabaId: async () => 'waba1', listActiveCampaignsForTemplate: aucuneCampagneActive },
        tracking: {
          allocate: async () => { throw new Error('base indisponible'); },
          liens: { confirm: async () => {}, deconfirmer: async () => {}, listByTemplates: async () => [] },
          lienDe: (c: string) => `https://mba.messagingme.app/r/${c}`,
          destinations: async () => new Map(),
        },
      },
    });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: corps });
    expect(res.statusCode).toBe(201);
    const envoye = JSON.parse(String(calls[0]!.init.body)) as { components: Array<{ type: string; buttons?: Array<{ url?: string }> }> };
    expect(envoye.components.find((c) => c.type === 'BUTTONS')!.buttons![1]!.url).toBe('https://client.fr/promo');
    await server.close();
  });

  it('🔴 la LISTE remontre le lien saisi, pas le nôtre', async () => {
    // Sans ça, la promesse « tu saisis ton lien » serait fausse dès le premier rechargement de la page.
    const meta = {
      data: [{
        id: 'tpl-1', name: 'promo_lien', status: 'APPROVED', category: 'MARKETING', language: 'fr',
        components: [
          { type: 'BODY', text: 'Bonjour' },
          { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Voir le site', url: 'https://mba.messagingme.app/r/code1aaaaaaa' }] },
        ],
      }],
    };
    const { fn } = makeFetch([{ ok: true, status: 200, json: meta }]);
    const t = tracage();
    await t.dep.allocate('t1', { buttonIndex: 1 }, 'https://client.fr/promo'); // le lien existe en base
    const server = buildServer({
      queue: new FakeQueue(),
      auth: { users: noUsers, secret: SECRET },
      templates: { ...modelesInertes, meta: { templateClientForTenant: async () => new MetaTemplateClient('tok', 'v23.0', fn) }, repo: { getTenantWabaId: async () => 'waba1', listActiveCampaignsForTemplate: aucuneCampagneActive }, tracking: t.dep },
    });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/templates', ...h(token) });
    const body = res.json<{ templates: Array<{ buttons?: Array<{ url?: string }> }> }>();
    expect(body.templates[0]!.buttons![0]!.url).toBe('https://client.fr/promo');
    await server.close();
  });
});

/**
 * Un faux `tracked_links` qui tient les règles de l'upsert réel (`allocate`, `src/links/tracked-links.pg.ts`) : un
 * code par position de bouton, GARDÉ d'une réservation à l'autre ; destination et jeton mis à jour ; confirmation
 * remise à zéro. C'est ce qui rend lisible ce que la table dit à l'ENVOI après une création ou une édition : les
 * boutons confirmés `avecJeton` sont ceux qui recevront un composant `url` (131008 s'il manque, 132000 en trop).
 */
function tableDesLiens() {
  type Ligne = LienTrace & { confirme: boolean };
  const lignes: Ligne[] = [];
  const journal: string[] = [];
  const lienDe = (code: string, avecJeton: boolean): string => `https://api.messagingme.app/r/${code}${avecJeton ? '/{{1}}' : ''}`;
  const dep = {
    allocate: async (_t: string, cible: CibleLien, destination: string, avecJeton: boolean): Promise<string> => {
      journal.push(`allocate:${cible.buttonIndex}:${destination}`);
      let l = lignes.find((x) => x.templateName === cible.templateName && x.templateLanguage === cible.templateLanguage
        && x.cardIndex === cible.cardIndex && x.buttonIndex === cible.buttonIndex);
      if (!l) {
        // Un code de la forme réelle (12 caractères de l'alphabet de `newTrackingCode`) : `codeDuLienTrace` le lit.
        l = { code: `ab12cd34ef${String(lignes.length + 1).padStart(2, '0')}`, ...cible, destination, avecJeton, confirme: false };
        lignes.push(l);
      }
      Object.assign(l, { destination, avecJeton, confirme: false });
      return l.code;
    },
    liens: {
      confirm: async (_t: string, codes: readonly string[]) => {
        journal.push(`confirm:${codes.join(',')}`);
        for (const l of lignes) if (codes.includes(l.code)) l.confirme = true;
      },
      deconfirmer: async (_t: string, codes: readonly string[]) => {
        journal.push(`deconfirmer:${codes.join(',')}`);
        for (const l of lignes) if (codes.includes(l.code)) l.confirme = false;
      },
      listByTemplates: async (_t: string, noms: readonly string[]): Promise<LienTrace[]> =>
        lignes.filter((l) => l.confirme && noms.includes(l.templateName)).map(({ confirme: _c, ...l }) => l),
    },
    lienDe,
    destinations: async () => new Map(lignes.flatMap((l) => [[lienDe(l.code, false), l.destination], [lienDe(l.code, true), l.destination]] as Array<[string, string]>)),
  };
  /** Ce que l'envoi lirait pour ce template : les boutons qui attendent le jeton du destinataire. */
  const boutonsAJeton = (nom: string): number[] => lignes.filter((l) => l.confirme && l.avecJeton && l.cardIndex === null && l.templateName === nom).map((l) => l.buttonIndex);
  return { lignes, journal, dep, boutonsAJeton, lienDe };
}

function serveurLiens(fn: FetchLike, t: ReturnType<typeof tableDesLiens>, champs: string[] = ['numero_commande'], lus: string[] = []) {
  return buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    templates: {
      ...modelesInertes,
      champsDeclares: async (tenant) => { lus.push(tenant); return champs; },
      meta: { templateClientForTenant: async () => new MetaTemplateClient('tok', 'v23.0', fn) },
      repo: { getTenantWabaId: async () => 'waba1', listActiveCampaignsForTemplate: aucuneCampagneActive },
      tracking: t.dep,
    },
  });
}

type CorpsMeta = { components: Array<{ type: string; buttons?: Array<{ type: string; url?: string }> }> };
const boutonsSoumis = (init: RequestInit): Array<{ type: string; url?: string }> =>
  (JSON.parse(String(init.body)) as CorpsMeta).components.find((c) => c.type === 'BUTTONS')!.buttons!;

describe('RC7 : un champ du contact dans l’adresse d’un bouton « Lien »', () => {
  const avecUrl = (url: string, name = 'suivi_commande') => ({
    name, language: 'fr', category: 'UTILITY', body: 'Votre commande est partie',
    buttons: [{ type: 'URL', text: 'Suivre ma commande', url }],
  });

  it('🔴 Meta reçoit NOTRE lien à jeton, jamais le champ ; la destination le garde, tracée avec jeton', async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { id: 'tpl-1', status: 'PENDING' } }]);
    const t = tableDesLiens();
    const server = serveurLiens(fn, t);
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: avecUrl('https://client.fr/commande/{numero_commande}') });
    expect(res.statusCode).toBe(201);
    expect(boutonsSoumis(calls[0]!.init)[0]!.url).toBe('https://api.messagingme.app/r/ab12cd34ef01/{{1}}');
    expect(String(calls[0]!.init.body)).not.toContain('numero_commande');
    expect(t.lignes[0]).toMatchObject({ destination: 'https://client.fr/commande/{numero_commande}', avecJeton: true, confirme: true });
    await server.close();
  });

  it('🔴 un champ dans le schéma, l’utilisateur, l’hôte ou le port : refusé, rien n’est réservé ni soumis', async () => {
    // Une valeur de fiche peut être écrite par le contact : dans l'hôte, elle ferait de notre domaine un redirecteur
    // ouvert. `new URL` accepte `{x}` dans un nom d'hôte, d'où une règle lue sur le texte. Le port et le schéma
    // tombent déjà sur la règle d'URL envoyable (`buttons invalides`) : on vérifie seulement qu'ils sont refusés.
    const lisibles = ['https://{prenom}.client.fr/a', 'https://client.{prenom}/a', 'https://{prenom}@client.fr/a', 'https://client.fr{prenom}/a', 'https://client.fr\\{prenom}'];
    for (const url of [...lisibles, 'https://client.fr:{prenom}/a', 'http{prenom}://client.fr/a']) {
      const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { id: 'tpl-1', status: 'PENDING' } }]);
      const t = tableDesLiens();
      const server = serveurLiens(fn, t);
      const res = await server.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: avecUrl(url) });
      expect(res.statusCode, url).toBe(400);
      if (lisibles.includes(url)) expect(res.json<{ error: string }>().error, url).toMatch(/après le nom du site/);
      expect(calls, url).toHaveLength(0);
      expect(t.journal, url).toEqual([]);
      await server.close();
    }
  });

  it('une clé inconnue, une accolade orpheline, un champ vide, un mélange avec {{1}} : refus lisible', async () => {
    const cas: Array<[string, RegExp]> = [
      ['https://client.fr/commande/{inconnu}', /\{inconnu\} n'existe pas/],
      ['https://client.fr/commande/{numero_commande', /accolade sans sa paire/],
      ['https://client.fr/commande/numero_commande}', /accolade sans sa paire/],
      ['https://client.fr/commande/{}', /champ vide/],
      ['https://client.fr/commande/{numero-commande}', /n'est pas un champ du contact/],
      ['https://client.fr/{prenom}/{{1}}', /variable \{\{1\}\}/],
    ];
    for (const [url, motif] of cas) {
      const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { id: 'tpl-1', status: 'PENDING' } }]);
      const server = serveurLiens(fn, tableDesLiens());
      const res = await server.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: avecUrl(url) });
      expect(res.statusCode, url).toBe(400);
      expect(res.json<{ error: string }>().error, url).toMatch(/bouton 1/);
      expect(res.json<{ error: string }>().error, url).toMatch(motif);
      expect(calls, url).toHaveLength(0);
      await server.close();
    }
  });

  it('les champs de base passent sans être déclarés ; les champs déclarés ne sont lus que pour une adresse à accolade', async () => {
    for (const url of ['https://client.fr/?p={prenom}&n={nom}#{telephone}', 'https://client.fr/promo']) {
      const { fn } = makeFetch([{ ok: true, status: 200, json: { id: 'tpl-1', status: 'PENDING' } }]);
      const lus: string[] = [];
      const server = serveurLiens(fn, tableDesLiens(), [], lus);
      const res = await server.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: avecUrl(url) });
      expect(res.statusCode, url).toBe(201);
      expect(lus, url).toEqual(url.includes('{') ? ['t1'] : []);
      await server.close();
    }
  });

  it('🔴 un champ dans le lien d’une CARTE de carousel est refusé : tracée sans jeton, elle ne le remplirait jamais', async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { id: 'tpl-1', status: 'PENDING' } }]);
    const server = serveurLiens(fn, tableDesLiens());
    const carte = (url: string) => ({ headerHandle: 'h', buttons: [{ type: 'URL', text: 'Voir', url }] });
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/templates', ...h(token),
      payload: { name: 'caro', language: 'fr', category: 'MARKETING', body: 'Nos offres', carousel: { cards: [carte('https://client.fr/a/{prenom}'), carte('https://client.fr/b')] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/carte 1, bouton 1 : un champ du contact ne peut pas/);
    expect(calls).toHaveLength(0);
    await server.close();
  });

  it('🔴 traçage en panne + bouton à champ : 422 lisible, et RIEN n’est soumis (le champ partirait en clair chez Meta)', async () => {
    // Le repli d'un bouton sans champ (soumettre l'adresse saisie) est tenu par le test « une panne du traçage… ».
    const { fn, calls } = makeFetch([{ ok: true, status: 200, json: { id: 'tpl-1', status: 'PENDING' } }]);
    const t = tableDesLiens();
    t.dep.allocate = async () => { throw new Error('base indisponible'); };
    const server = serveurLiens(fn, t);
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: avecUrl('https://client.fr/commande/{numero_commande}') });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toMatch(/n'a pas été soumis/);
    expect(calls).toHaveLength(0);
    await server.close();
  });

  it('🔴 Meta REFUSE une création (nom déjà pris) : les liens du template en service restent confirmés', async () => {
    // `allocate` remet la confirmation à zéro sur la même position : sans remise en l'état, l'envoi du template
    // DÉJÀ approuvé partait sans son jeton, et Meta refusait chaque message (131008).
    const t = tableDesLiens();
    const cible = { templateName: 'suivi_commande', templateLanguage: 'fr', cardIndex: null, buttonIndex: 0 };
    const code = await t.dep.allocate('t1', cible, 'https://client.fr/suivi', true);
    await t.dep.liens.confirm('t1', [code]);
    const { fn } = makeFetch([{ ok: false, status: 400, json: { error: { message: 'Content in this language already exists' } } }]);
    const server = serveurLiens(fn, t);
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/templates', ...h(token), payload: avecUrl('https://client.fr/autre/{numero_commande}') });
    expect(res.statusCode).toBe(422);
    expect(t.boutonsAJeton('suivi_commande')).toEqual([0]);
    expect(t.lignes).toEqual([{ ...cible, code, destination: 'https://client.fr/suivi', avecJeton: true, confirme: true }]);
    await server.close();
  });
});

describe('🔴 RC7 : l’ÉDITION (PATCH) repasse par le traçage', () => {
  const nom = 'promo';
  /** Le template tel que Meta le rend : ses boutons portent NOS liens, la console en réaffiche la destination. */
  const chezMeta = (urls: string[]) => ({ ok: true, status: 200, json: { data: [{
    id: 'TID', name: nom, status: 'APPROVED', category: 'MARKETING', language: 'fr',
    components: [{ type: 'BODY', text: 'Ancien' }, { type: 'BUTTONS', buttons: urls.map((url, i) => ({ type: 'URL', text: `Lien ${i + 1}`, url })) }],
  }] } });
  /** Un template créé par la console : ses boutons sont tracés, confirmés, à jeton. */
  async function dejaCree(destinations: string[]) {
    const t = tableDesLiens();
    const codes: string[] = [];
    for (const [i, d] of destinations.entries()) codes.push(await t.dep.allocate('t1', { templateName: nom, templateLanguage: 'fr', cardIndex: null, buttonIndex: i }, d, true));
    await t.dep.liens.confirm('t1', codes);
    t.journal.length = 0;
    return { t, codes };
  }
  const edition = (urls: string[]) => ({
    language: 'fr', category: 'MARKETING', body: 'Nouveau',
    buttons: urls.map((url, i) => ({ type: 'URL', text: `Lien ${i + 1}`, url })),
  });

  it('🔴 l’adresse SAISIE que renvoie la console ne remplace pas notre lien chez Meta', async () => {
    // Le défaut : la console réaffiche la destination (`rehabillerTemplates`) et la renvoie telle quelle au PATCH.
    // Meta recevait alors l'adresse brute, alors que `tracked_links` disait toujours ce bouton confirmé à jeton :
    // chaque envoi ajoutait un composant `url` à un template qui n'avait plus de variable.
    const { t, codes } = await dejaCree(['https://client.fr/promo']);
    const { fn, calls } = makeFetch([chezMeta([t.lienDe(codes[0]!, true)]), { ok: true, status: 200, json: { success: true } }]);
    const server = serveurLiens(fn, t);
    const res = await server.inject({ method: 'PATCH', url: `/tenants/t1/templates/${nom}`, ...h(token), payload: edition(['https://client.fr/promo']) });
    expect(res.statusCode).toBe(200);
    expect(boutonsSoumis(calls[1]!.init)[0]!.url).toBe(t.lienDe(codes[0]!, true));
    // Ce que l'envoi lira est cohérent avec ce que Meta porte : un bouton à jeton, confirmé.
    expect(t.boutonsAJeton(nom)).toEqual([0]);
    await server.close();
  });

  it('le code du bouton est GARDÉ et suit la destination à jour, champ compris : ce qui est déjà parti résout', async () => {
    const { t, codes } = await dejaCree(['https://client.fr/promo']);
    const { fn, calls } = makeFetch([chezMeta([t.lienDe(codes[0]!, true)]), { ok: true, status: 200, json: { success: true } }]);
    const server = serveurLiens(fn, t);
    const res = await server.inject({ method: 'PATCH', url: `/tenants/t1/templates/${nom}`, ...h(token), payload: edition(['https://client.fr/commande/{numero_commande}']) });
    expect(res.statusCode).toBe(200);
    expect(boutonsSoumis(calls[1]!.init)[0]!.url).toBe(t.lienDe(codes[0]!, true));
    expect(t.lignes).toHaveLength(1);
    expect(t.lignes[0]).toMatchObject({ code: codes[0], destination: 'https://client.fr/commande/{numero_commande}', confirme: true });
    await server.close();
  });

  it('🔴 Meta REFUSE l’édition : les liens d’avant sont remis en l’état (sinon chaque envoi part sans son jeton)', async () => {
    // Meta limite les éditions d'un template approuvé : un refus est un cas ordinaire, pas une panne.
    const { t, codes } = await dejaCree(['https://client.fr/promo']);
    const { fn } = makeFetch([chezMeta([t.lienDe(codes[0]!, true)]), { ok: false, status: 400, json: { error: { message: 'edit limit reached' } } }]);
    const server = serveurLiens(fn, t);
    const res = await server.inject({ method: 'PATCH', url: `/tenants/t1/templates/${nom}`, ...h(token), payload: edition(['https://client.fr/autre']) });
    expect(res.statusCode).toBe(422);
    expect(t.boutonsAJeton(nom)).toEqual([0]);
    expect(t.lignes[0]).toMatchObject({ code: codes[0], destination: 'https://client.fr/promo', avecJeton: true, confirme: true });
    await server.close();
  });

  it('🔴 notre lien réaffiché BRUT (ancien nom d’hôte, pas de ré-habillage) : ni retracé ni déconfirmé', async () => {
    // Le ré-habillage ne connaît que l'hôte d'aujourd'hui : un template soumis sous `mba.` réaffiche notre lien brut,
    // et l'édition le renvoie tel quel. Le retracer donnerait au code sa propre adresse (une boucle) ; le déconfirmer
    // ferait partir chaque envoi sans son jeton, alors que Meta le porte toujours.
    for (const avecJeton of [true, false]) {
      const t = tableDesLiens();
      const cible = { templateName: nom, templateLanguage: 'fr', cardIndex: null, buttonIndex: 0 };
      const code = await t.dep.allocate('t1', cible, 'https://client.fr/promo', avecJeton);
      await t.dep.liens.confirm('t1', [code]);
      t.journal.length = 0;
      const brut = `https://mba.messagingme.app/r/${code}${avecJeton ? '/{{1}}' : ''}`;
      const { fn, calls } = makeFetch([chezMeta([brut]), { ok: true, status: 200, json: { success: true } }]);
      const server = serveurLiens(fn, t);
      const res = await server.inject({ method: 'PATCH', url: `/tenants/t1/templates/${nom}`, ...h(token), payload: edition([brut]) });
      expect(res.statusCode, brut).toBe(200);
      expect(boutonsSoumis(calls[1]!.init)[0]!.url, brut).toBe(brut);
      expect(t.journal, brut).toEqual([]);
      expect(t.lignes, brut).toEqual([{ ...cible, code, destination: 'https://client.fr/promo', avecJeton, confirme: true }]);
      await server.close();
    }
  });

  it('🔴 une édition qui RETIRE un bouton tracé le déconfirme : l’envoi ne réclame plus de jeton pour un bouton disparu', async () => {
    const { t, codes } = await dejaCree(['https://client.fr/a', 'https://client.fr/b']);
    const { fn } = makeFetch([chezMeta(codes.map((c) => t.lienDe(c, true))), { ok: true, status: 200, json: { success: true } }]);
    const server = serveurLiens(fn, t);
    const res = await server.inject({ method: 'PATCH', url: `/tenants/t1/templates/${nom}`, ...h(token), payload: edition(['https://client.fr/a']) });
    expect(res.statusCode).toBe(200);
    expect(t.boutonsAJeton(nom)).toEqual([0]);
    // La ligne RESTE (porte à sens unique : son code redirige toujours), elle n'est plus confirmée.
    expect(t.lignes.find((l) => l.code === codes[1])).toMatchObject({ destination: 'https://client.fr/b', confirme: false });
    expect(t.journal).toContain(`deconfirmer:${codes[1]}`);
    await server.close();
  });
});
