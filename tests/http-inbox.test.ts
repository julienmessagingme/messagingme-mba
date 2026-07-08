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
    getConversationWaId: async (id) => (id === 'c1' ? '33611' : null),
    getMessages: async () => [
      { id: 'm1', direction: 'in', type: 'text', body: 'coucou', buttonPayload: null, createdAt: '2026-07-06T00:00:00.000Z' },
    ],
    recordOutbound: async () => {},
    getTenantPhoneNumberId: async () => 'pn1',
    sendReply: async () => 'wamid.OUT',
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

  it('GET messages d une conversation connue -> 200', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/c1/messages', ...auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ waId: string; messages: Array<{ body: string }> }>();
    expect(body.waId).toBe('33611');
    expect(body.messages[0]?.body).toBe('coucou');
    await a.close();
  });

  it('GET messages conversation inconnue -> 404', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/nope/messages', ...auth() });
    expect(res.statusCode).toBe(404);
    await a.close();
  });

  it('POST reply -> envoie et journalise (200)', async () => {
    let recorded: [string, string, string | null] | null = null;
    let sent: [string, string, string] | null = null;
    const a = app({
      recordOutbound: async (id, body, msgId) => { recorded = [id, body, msgId]; },
      sendReply: async (pn, to, text) => { sent = [pn, to, text]; return 'wamid.OUT'; },
    });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...auth(), payload: { text: 'Merci !' } });
    expect(res.statusCode).toBe(200);
    expect(sent).toEqual(['pn1', '33611', 'Merci !']);
    expect(recorded).toEqual(['c1', 'Merci !', 'wamid.OUT']);
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
