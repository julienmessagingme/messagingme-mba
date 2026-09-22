import { describe, it, expect, beforeAll } from 'vitest';
import { jamaisDesabonne } from './consentement';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { InboxRouteDeps } from '../src/http/inbox';
import type { ListConversationsOptions } from '../src/inbox/store.pg';

/**
 * « OUVRIR LA CONVERSATION » DEPUIS LA FICHE D'UN CONTACT (demande de Julien du 2026-09-23).
 *
 * 🔴 CE QUE CES TESTS PROTEGENT. Le geste ECRIT : un contact qui n'a jamais parle n'a pas de fil, et c'est
 * precisement quand on veut lui ecrire qu'on ouvre sa fiche. Trois proprietes en decoulent, et aucune ne se
 * voit dans un type : la route est un POST (un GET qui cree une ligne, un prechargement de navigateur le
 * declenche tout seul), elle est scopee a l'espace (le filtrage en code est le SEUL controle d'isolation,
 * la RLS etant contournee par le pooler), et elle rend 404 plutot qu'un fil invente quand le contact n'a
 * aucune identite joignable.
 */
const SECRET = 'test-secret';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const CONV = '11111111-1111-4111-8111-111111111111';
let token = '';
beforeAll(async () => { token = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET); });
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const auth = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });

function app(over: Partial<InboxRouteDeps> = {}) {
  const deps: InboxRouteDeps = {
    estDesabonne: jamaisDesabonne,
    listConversations: async () => [],
    getConversationContext: async () => null,
    getMessages: async () => [],
    recordOutbound: async () => {},
    getTenantPhoneNumberId: async () => 'pn1',
    sendReply: async () => 'wamid.OUT',
    sendTemplateMessage: async () => 'wamid.TPL',
    ...over,
  };
  return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, inbox: deps });
}

describe('POST /contacts/:id/conversation', () => {
  it('rend l identifiant du fil, et passe l ESPACE au magasin', async () => {
    const vus: { tenant: string; contact: string }[] = [];
    const a = app({
      ouvrirConversationDuContact: async (tenant, contactId) => { vus.push({ tenant, contact: contactId }); return CONV; },
    });
    const r = await a.inject({ method: 'POST', url: `/tenants/t1/contacts/${CONTACT}/conversation`, ...auth() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ conversationId: CONV });
    // 🔴 Le tenant vient de la SESSION (`scopeTenant`), pas de l'URL : c'est le seul controle d'isolation.
    expect(vus).toEqual([{ tenant: 't1', contact: CONTACT }]);
  });

  it('🔴 un contact d un AUTRE espace ne s ouvre pas', async () => {
    const a = app({ ouvrirConversationDuContact: async () => CONV });
    const r = await a.inject({ method: 'POST', url: `/tenants/t2/contacts/${CONTACT}/conversation`, ...auth() });
    expect(r.statusCode).toBe(403);
  });

  it('🔴 contact introuvable ou sans identite joignable -> 404, jamais un fil invente', async () => {
    // Sans numero ni bsuid, il n'y a aucun fil possible : en creer un le rendrait inatteignable, et l'ecran
    // enverrait l'operateur sur une conversation qui ne recevra jamais rien.
    const a = app({ ouvrirConversationDuContact: async () => null });
    const r = await a.inject({ method: 'POST', url: `/tenants/t1/contacts/${CONTACT}/conversation`, ...auth() });
    expect(r.statusCode).toBe(404);
  });

  it('magasin plus ancien que la route -> 503, et l Inbox continue de fonctionner', async () => {
    const a = app();
    const r = await a.inject({ method: 'POST', url: `/tenants/t1/contacts/${CONTACT}/conversation`, ...auth() });
    expect(r.statusCode).toBe(503);
  });

  it('sans session, rien ne s ouvre', async () => {
    const a = app({ ouvrirConversationDuContact: async () => CONV });
    const r = await a.inject({ method: 'POST', url: `/tenants/t1/contacts/${CONTACT}/conversation` });
    expect(r.statusCode).toBe(401);
  });
});

describe('GET /conversations?id=', () => {
  it('🔴 le filtre par identifiant est LU par la route, et transmis au magasin', async () => {
    // Le motif « une capacite cablee sur deux consommateurs sur trois » : le magasin la supporte, l'ecran
    // l'envoie, et c'est la route, au milieu, qui l'a deja jetee une fois (le filtre par membre, 2026-09-15).
    const vus: ListConversationsOptions[] = [];
    const a = app({ listConversations: async (_t, opts) => { vus.push(opts ?? {}); return []; } });
    const r = await a.inject({ method: 'GET', url: `/tenants/t1/conversations?id=${CONV}&limit=1`, ...auth() });
    expect(r.statusCode).toBe(200);
    expect(vus[0]?.id).toBe(CONV);
  });

  it('un identifiant vide n est pas un filtre', async () => {
    const vus: ListConversationsOptions[] = [];
    const a = app({ listConversations: async (_t, opts) => { vus.push(opts ?? {}); return []; } });
    await a.inject({ method: 'GET', url: '/tenants/t1/conversations?id=', ...auth() });
    expect(vus[0]?.id).toBeUndefined();
  });
});
