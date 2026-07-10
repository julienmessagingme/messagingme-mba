import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { UserStateLoader } from '../src/auth/middleware';
import type { CampaignRouteDeps } from '../src/http/campaigns';
import type { InboxRouteDeps } from '../src/http/inbox';

// Re-vérification par requête de l'état du compte (getUserState) : révoqué/supprimé -> 401 immédiat,
// rôle rafraîchi depuis la base -> un changement de rôle prend effet sans attendre l'expiration du JWT.

const SECRET = 'test-secret';
let adminTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const campaigns: CampaignRouteDeps = {
  repo: {} as CampaignRouteDeps['repo'],
  queue: new FakeQueue(),
  phoneNumberBelongsToTenant: async () => true,
  campaignBelongsTo: async () => true,
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

function app(getUserState: UserStateLoader) {
  return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET, getUserState }, campaigns, inbox });
}

describe('requireAuth — état du compte relu en base', () => {
  it('compte actif -> accès normal (200)', async () => {
    const a = app(async () => ({ role: 'admin', disabled: false }));
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    await a.close();
  });

  it('compte RÉVOQUÉ (disabled) -> 401 même avec un JWT valide', async () => {
    const a = app(async () => ({ role: 'admin', disabled: true }));
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...h(adminTok) });
    expect(res.statusCode).toBe(401);
    await a.close();
  });

  it('compte SUPPRIMÉ (null) -> 401', async () => {
    const a = app(async () => null);
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...h(adminTok) });
    expect(res.statusCode).toBe(401);
    await a.close();
  });

  it('rôle rétrogradé en base -> effet immédiat : token admin, rôle agent -> campagnes 403, inbox 200', async () => {
    const a = app(async () => ({ role: 'agent', disabled: false }));
    const camp = await a.inject({ method: 'GET', url: '/tenants/t1/campaigns', ...h(adminTok) });
    const inb = await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...h(adminTok) });
    expect(camp.statusCode).toBe(403); // rôle frais = agent -> groupe admin-only refusé
    expect(inb.statusCode).toBe(200); // agent garde l'inbox
    await a.close();
  });
});
