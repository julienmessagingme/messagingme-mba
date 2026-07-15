import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { CampaignRouteDeps } from '../src/http/campaigns';
import type { InboxRouteDeps } from '../src/http/inbox';

// Frontière RBAC (Feature 2) : l'agent n'a accès QU'À l'inbox. Le même token agent doit être
// admis sur l'inbox et refusé (403) sur un groupe admin-only. La barrière est le preHandler
// composé [requireAuth, makeRequireRole(['admin'])] posé sur tous les groupes sauf l'inbox.

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const campaigns: CampaignRouteDeps = {
  repo: {} as CampaignRouteDeps['repo'],
  queue: new FakeQueue(),
  phoneNumberBelongsToTenant: async () => true,
  campaignBelongsTo: async () => true,
  getWorkflowGraph: async () => null,
  listCampaigns: async () => [],
  getCampaignDetail: async () => null,
  listPhoneNumbers: async () => [],
};
const inbox: InboxRouteDeps = {
  listConversations: async () => [],
  getConversationContext: async () => null,
  getMessages: async () => [],
  recordOutbound: async () => {},
  getTenantPhoneNumberId: async () => 'pn1',
  sendReply: async () => 'wamid.OUT',
  sendTemplateMessage: async () => 'wamid.TPL',
};

function app() {
  return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, campaigns, inbox });
}

describe('RBAC — agent = inbox uniquement', () => {
  it('agent : inbox OK (200), campagnes refusé (403)', async () => {
    const a = app();
    const inboxRes = await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...h(agentTok) });
    const campRes = await a.inject({ method: 'GET', url: '/tenants/t1/campaigns', ...h(agentTok) });
    expect(inboxRes.statusCode).toBe(200);
    expect(campRes.statusCode).toBe(403);
    await a.close();
  });

  it('admin : inbox ET campagnes OK (200)', async () => {
    const a = app();
    const inboxRes = await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...h(adminTok) });
    const campRes = await a.inject({ method: 'GET', url: '/tenants/t1/campaigns', ...h(adminTok) });
    expect(inboxRes.statusCode).toBe(200);
    expect(campRes.statusCode).toBe(200);
    await a.close();
  });

  it('sans token : inbox ET campagnes -> 401', async () => {
    const a = app();
    const inboxRes = await a.inject({ method: 'GET', url: '/tenants/t1/conversations' });
    const campRes = await a.inject({ method: 'GET', url: '/tenants/t1/campaigns' });
    expect(inboxRes.statusCode).toBe(401);
    expect(campRes.statusCode).toBe(401);
    await a.close();
  });
});
