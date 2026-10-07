import { jamaisDesabonne } from './consentement';
import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { UserStateLoader } from '../src/auth/middleware';
import type { CampaignRouteDeps } from '../src/http/campaigns';
import type { InboxRouteDeps } from '../src/http/inbox';
import { campagnesInertes, campagnesRepoInerte, creationInerte, inboxDepInerte, inboxInerte } from './routes-inertes';

// Re-vérification par requête de l'état du compte (getUserState) : révoqué/supprimé -> 401 immédiat,
// rôle rafraîchi depuis la base -> un changement de rôle prend effet sans attendre l'expiration du JWT.

const SECRET = 'test-secret';
let adminTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const campaigns: CampaignRouteDeps = {
  ...campagnesInertes,
  queue: new FakeQueue(),
  repo: {
    ...creationInerte,
    ...campagnesRepoInerte,
    phoneNumberBelongsToTenant: async () => true,
    campaignBelongsTo: async () => true,
    getRunSizing: async () => ({ ratePerMinute: null, pendingCount: 0 }),
    scheduleCampaign: async () => true,
    cancelSchedule: async () => true,
    listCampaignSummaries: async () => [],
    archiveCampaign: async () => true,
    unarchiveCampaign: async () => true,
    deleteDraftCampaign: async () => true,
    getCampaignDetail: async () => null,
    resetRecipientForRetry: async () => ({ result: 'not_found' as const }),
    listPhoneNumbers: async () => [],
  },
  getWorkflowGraph: async () => null,
};
const inbox: InboxRouteDeps = {
  ...inboxInerte,
  estDesabonne: jamaisDesabonne,
  inbox: {
    ...inboxDepInerte,
    listConversations: async () => [],
    getConversationContext: async () => null,
    getMessages: async () => [],
    recordOutbound: async () => {},
  },
  repo: {
    getTenantPhoneNumberId: async () => 'pn1',
  },
  sendReply: async () => 'wamid.OUT',
  sendTemplateMessage: async () => 'wamid.TPL',
};

function app(getUserState: UserStateLoader) {
  return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET, getUserState }, campaigns, inbox });
}

describe('requireAuth — état du compte relu en base', () => {
  it('compte actif -> accès normal (200)', async () => {
    const a = app(async () => ({ role: 'admin', disabled: false, horsOffre: null }));
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    await a.close();
  });

  it('compte RÉVOQUÉ (disabled) -> 401 même avec un JWT valide', async () => {
    const a = app(async () => ({ role: 'admin', disabled: true, horsOffre: null }));
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
    const a = app(async () => ({ role: 'agent', disabled: false, horsOffre: null }));
    const camp = await a.inject({ method: 'GET', url: '/tenants/t1/campaigns', ...h(adminTok) });
    const inb = await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...h(adminTok) });
    expect(camp.statusCode).toBe(403); // rôle frais = agent -> groupe admin-only refusé
    expect(inb.statusCode).toBe(200); // agent garde l'inbox
    await a.close();
  });

  it('crochet paiement : espace LOCKED -> 403 partout (compte pourtant actif)', async () => {
    const a = app(async () => ({ role: 'admin', disabled: false, tenantStatus: 'locked', horsOffre: null }));
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...h(adminTok) });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code?: string }>().code).toBe('tenant_locked');
    await a.close();
  });

  it('🔴 membre au-delà de l’offre (lot 6, B2a) -> 402 plan_limit_reached, accès suspendu, sur une lecture comme sur un geste', async () => {
    const a = app(async () => ({ role: 'admin', disabled: false, horsOffre: { limite: 'admins', max: 1 } }));
    for (const r of [
      await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...h(adminTok) }),
      await a.inject({ method: 'GET', url: '/tenants/t1/campaigns', ...h(adminTok) }),
    ]) {
      expect(r.statusCode).toBe(402);
      expect(r.json()).toMatchObject({ code: 'plan_limit_reached', limite: 'admins', max: 1, acces: 'suspendu', upgradeUrl: expect.stringMatching(/\/offre$/) });
    }
    await a.close();
  });

  it('espace ACTIVE (ou statut absent) -> accès normal (crochet inerte)', async () => {
    const a = app(async () => ({ role: 'admin', disabled: false, tenantStatus: 'active', horsOffre: null }));
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    await a.close();
  });
});
