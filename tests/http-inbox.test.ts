import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { InboxRouteDeps } from '../src/http/inbox';

const SECRET = 'test-secret';
let token = '';
beforeAll(async () => {
  token = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const auth = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });

function app(over: Partial<InboxRouteDeps> = {}) {
  const deps: InboxRouteDeps = {
    listConversations: async () => [
      { id: 'c1', waId: '33611', profileName: 'Julie', lastPreview: 'Oui', lastMessageAt: '2026-07-06T00:00:00.000Z' },
    ],
    getConversationContext: async (id) => (id === 'c1' ? { waId: '33611', windowOpen: true, lastInboundAt: '2026-07-06T00:00:00.000Z' } : null),
    getMessages: async () => [
      { id: 'm1', direction: 'in', type: 'text', body: 'coucou', buttonPayload: null, createdAt: '2026-07-06T00:00:00.000Z' },
    ],
    recordOutbound: async () => {},
    getTenantPhoneNumberId: async () => 'pn1',
    sendReply: async () => 'wamid.OUT',
    sendTemplateMessage: async () => 'wamid.TPL',
    ...over,
  };
  return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, inbox: deps });
}

describe('inbox routes', () => {
  it('GET conversations -> liste', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ conversations: Array<{ waId: string }> }>().conversations[0]?.waId).toBe('33611');
    await a.close();
  });

  it('GET messages d une conversation connue -> 200 + windowOpen', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/c1/messages', ...auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ waId: string; windowOpen: boolean; messages: Array<{ body: string }> }>();
    expect(body.waId).toBe('33611');
    expect(body.windowOpen).toBe(true);
    expect(body.messages[0]?.body).toBe('coucou');
    await a.close();
  });

  it('GET messages conversation inconnue -> 404', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/nope/messages', ...auth() });
    expect(res.statusCode).toBe(404);
    await a.close();
  });

  it('POST reply (fenêtre ouverte) -> envoie et journalise (200)', async () => {
    let recorded: [string, string, string | null, string | undefined] | null = null;
    let sent: [string, string, string] | null = null;
    const a = app({
      recordOutbound: async (id, body, msgId, type) => { recorded = [id, body, msgId, type]; },
      sendReply: async (pn, to, text) => { sent = [pn, to, text]; return 'wamid.OUT'; },
    });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...auth(), payload: { text: 'Merci !' } });
    expect(res.statusCode).toBe(200);
    expect(sent).toEqual(['pn1', '33611', 'Merci !']);
    expect(recorded).toEqual(['c1', 'Merci !', 'wamid.OUT', 'text']);
    await a.close();
  });

  it('POST reply -> journalise l auteur (sender_user_id du JWT) en 7e position', async () => {
    let sender: string | null | undefined = 'UNSET';
    const a = app({
      recordOutbound: async (_id, _body, _msg, _type, _cat, _name, s) => { sender = s; },
    });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...auth(), payload: { text: 'Merci !' } });
    expect(res.statusCode).toBe(200);
    expect(sender).toBe('u1'); // userId du token
    await a.close();
  });

  it('GET messages -> expose senderName sur les bulles sortantes', async () => {
    const a = app({
      getMessages: async () => [
        { id: 'm2', direction: 'out', type: 'text', body: 'Bonjour', buttonPayload: null, createdAt: '2026-07-06T00:00:00.000Z', senderName: 'Julien' },
      ],
    });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/c1/messages', ...auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ messages: Array<{ senderName?: string }> }>().messages[0]?.senderName).toBe('Julien');
    await a.close();
  });

  it('POST reply HORS fenêtre 24 h -> 422 (texte libre interdit)', async () => {
    const a = app({
      getConversationContext: async () => ({ waId: '33611', windowOpen: false, lastInboundAt: '2026-07-01T00:00:00.000Z' }),
    });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...auth(), payload: { text: 'coucou' } });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('window_closed');
    await a.close();
  });

  it('POST send-template -> envoie le template (200), autorisé hors fenêtre', async () => {
    let sent: { pn: string; to: string; tpl: unknown } | null = null;
    let recordedType: string | undefined;
    const a = app({
      getConversationContext: async () => ({ waId: '33611', windowOpen: false, lastInboundAt: '2026-07-01T00:00:00.000Z' }),
      sendTemplateMessage: async (pn, to, tpl) => { sent = { pn, to, tpl }; return 'wamid.TPL'; },
      recordOutbound: async (_id, _body, _msg, type) => { recordedType = type; },
    });
    const res = await a.inject({
      method: 'POST',
      url: '/tenants/t1/conversations/c1/send-template',
      ...auth(),
      payload: { templateName: 'promo', language: 'fr', bodyParams: ['Julie'], headerMediaUrl: 'https://x.fr/v.mp4', headerFormat: 'VIDEO' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ messageId: string }>().messageId).toBe('wamid.TPL');
    expect(sent).toMatchObject({ pn: 'pn1', to: '33611', tpl: { name: 'promo', language: 'fr', bodyParams: ['Julie'], headerMediaUrl: 'https://x.fr/v.mp4', headerFormat: 'VIDEO' } });
    expect(recordedType).toBe('template');
    await a.close();
  });

  it('POST send-template -> persiste la catégorie normalisée en minuscule (le split dashboard)', async () => {
    let recorded: { type?: string; cat?: string | null; name?: string | null } = {};
    const a = app({
      getConversationContext: async () => ({ waId: '33611', windowOpen: false, lastInboundAt: '2026-07-01T00:00:00.000Z' }),
      recordOutbound: async (_id, _body, _msg, type, cat, name) => { recorded = { type, cat, name }; },
    });
    const res = await a.inject({
      method: 'POST',
      url: '/tenants/t1/conversations/c1/send-template',
      ...auth(),
      payload: { templateName: 'promo', language: 'fr', templateCategory: 'MARKETING' },
    });
    expect(res.statusCode).toBe(200);
    expect(recorded).toEqual({ type: 'template', cat: 'marketing', name: 'promo' });
    await a.close();
  });

  it('POST send-template -> catégorie absente ou invalide persiste null', async () => {
    const cats: Array<string | null> = [];
    const a = app({
      getConversationContext: async () => ({ waId: '33611', windowOpen: false, lastInboundAt: '2026-07-01T00:00:00.000Z' }),
      recordOutbound: async (_id, _body, _msg, _type, cat) => { cats.push(cat ?? null); },
    });
    // catégorie inconnue (ex. AUTHENTICATION / typo) -> null
    const r1 = await a.inject({
      method: 'POST', url: '/tenants/t1/conversations/c1/send-template', ...auth(),
      payload: { templateName: 'otp', language: 'fr', templateCategory: 'AUTHENTICATION' },
    });
    // catégorie absente -> null
    const r2 = await a.inject({
      method: 'POST', url: '/tenants/t1/conversations/c1/send-template', ...auth(),
      payload: { templateName: 'otp', language: 'fr' },
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(cats).toEqual([null, null]);
    await a.close();
  });

  it('POST send-template sans templateName -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/send-template', ...auth(), payload: { language: 'fr' } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('POST reply texte vide -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...auth(), payload: { text: '  ' } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('POST reply conversation inconnue -> 404', async () => {
    const a = app();
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/nope/reply', ...auth(), payload: { text: 'x' } });
    expect(res.statusCode).toBe(404);
    await a.close();
  });

  it('sans token -> 401', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations' });
    expect(res.statusCode).toBe(401);
    await a.close();
  });

  it('tenant != token -> 403', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/AUTRE/conversations', ...auth() });
    expect(res.statusCode).toBe(403);
    await a.close();
  });
});
