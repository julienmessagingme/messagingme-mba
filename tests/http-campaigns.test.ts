import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { CampaignRepoLike } from '../src/campaign/create';
import type { CreateCampaignInput } from '../src/campaign/store.pg';
import type { BuildContact, BuiltRecipient } from '../src/campaign/build';

const SECRET = 'test-secret';
let token = '';
beforeAll(async () => {
  token = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const auth = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });

class FakeRepo implements CampaignRepoLike {
  readonly created: CreateCampaignInput[] = [];
  lastRecipients: BuiltRecipient[] = [];
  constructor(private readonly contacts: BuildContact[]) {}
  async insertCampaign(input: CreateCampaignInput): Promise<string> {
    this.created.push(input);
    return 'camp-1';
  }
  async listContactsForBuild(): Promise<BuildContact[]> {
    return this.contacts;
  }
  async insertRecipients(_campaignId: string, recipients: BuiltRecipient[]): Promise<number> {
    this.lastRecipients = recipients;
    return recipients.length;
  }
}

const contacts: BuildContact[] = [
  { id: 'c1', phone_e164: '+33611', profile_name: 'A', fields: {}, optInStatus: 'opted_in' },
  { id: 'c2', phone_e164: '+33622', profile_name: 'B', fields: {}, optInStatus: 'unknown' },
];

const validBody = {
  phoneNumberId: 'pn1',
  name: 'Promo été',
  category: 'marketing',
  templateName: 'promo',
  templateLanguage: 'fr',
  paramMapping: [],
};

interface Deps {
  ownsNumber?: boolean;
  campaignTenant?: string; // tenant propriétaire de 'known'
  queue?: FakeQueue;
}
function appWith(repo: FakeRepo, d: Deps = {}) {
  return buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    campaigns: {
      repo,
      queue: d.queue ?? new FakeQueue(),
      phoneNumberBelongsToTenant: async () => d.ownsNumber ?? true,
      campaignBelongsTo: async (id, tenant) => id === 'known' && tenant === (d.campaignTenant ?? 't1'),
      listCampaigns: async (tenant) => [
        { id: 'camp-1', name: 'Promo', category: 'marketing', status: 'draft', phoneNumberId: 'pn1', templateName: 'promo', templateLanguage: 'fr', createdAt: '2026-07-05T00:00:00.000Z', counts: { total: 2, pending: 2, sending: 0, sent: 0, failed: 0, skipped: 0 }, _t: tenant } as never,
      ],
      getCampaignDetail: async (id, tenant) =>
        id === 'known' && tenant === 't1'
          ? ({ id: 'known', name: 'Promo', category: 'marketing', status: 'completed', phoneNumberId: 'pn1', templateName: 'promo', templateLanguage: 'fr', createdAt: '2026-07-05T00:00:00.000Z', counts: { total: 1, pending: 0, sending: 0, sent: 1, failed: 0, skipped: 0 }, recipients: [{ id: 'r1', toE164: '+33611', status: 'sent', messageId: 'm-1', error: null, sentAt: '2026-07-05T00:00:00.000Z' }] } as never)
          : null,
      listPhoneNumbers: async () => [{ id: 'pn1', displayPhoneNumber: '+33600000000', verifiedName: 'Demo' }],
    },
  });
}

describe('POST /tenants/:tenantId/campaigns', () => {
  it('crée la campagne et construit les destinataires (opt-in filtré)', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo);
    const res = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns', ...auth(), payload: validBody });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ campaignId: string; recipientCount: number }>();
    expect(body).toEqual({ campaignId: 'camp-1', recipientCount: 1 }); // c2 non opt-in exclu
    expect(repo.created[0]?.tenantId).toBe('t1');
    await app.close();
  });

  it('sans token -> 401', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo);
    const res = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns', headers: { 'content-type': 'application/json' }, payload: validBody });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('tenant de l URL != tenant du token -> 403', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo);
    const res = await app.inject({ method: 'POST', url: '/tenants/AUTRE/campaigns', ...auth(), payload: validBody });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('phoneNumberId non détenu par le tenant -> 400', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo, { ownsNumber: false });
    const res = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns', ...auth(), payload: validBody });
    expect(res.statusCode).toBe(400);
    expect(repo.created).toHaveLength(0);
    await app.close();
  });

  it('category invalide -> 400', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo);
    const res = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns', ...auth(), payload: { ...validBody, category: 'promo' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('paramMapping invalide (positions non contiguës) -> 400, rien inséré', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo);
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/campaigns',
      ...auth(),
      payload: { ...validBody, paramMapping: [{ position: 5, source: { type: 'literal', value: 'x' } }] },
    });
    expect(res.statusCode).toBe(400);
    expect(repo.created).toHaveLength(0);
    await app.close();
  });
});

describe('POST /campaigns/:campaignId/run', () => {
  it('campagne du tenant -> 202 + job campaign-run enqueué', async () => {
    const q = new FakeQueue();
    const app = appWith(new FakeRepo(contacts), { queue: q });
    const res = await app.inject({ method: 'POST', url: '/campaigns/known/run', ...auth() });
    expect(res.statusCode).toBe(202);
    expect(q.enqueued).toEqual([{ name: 'campaign-run', data: { campaignId: 'known' } }]);
    await app.close();
  });

  it('campagne d un autre tenant / inconnue -> 404, rien enqueué', async () => {
    const q = new FakeQueue();
    const app = appWith(new FakeRepo(contacts), { queue: q, campaignTenant: 'AUTRE' });
    const res = await app.inject({ method: 'POST', url: '/campaigns/known/run', ...auth() });
    expect(res.statusCode).toBe(404);
    expect(q.enqueued).toEqual([]);
    await app.close();
  });

  it('sans token -> 401', async () => {
    const app = appWith(new FakeRepo(contacts));
    const res = await app.inject({ method: 'POST', url: '/campaigns/known/run' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('lecture campagnes (GET)', () => {
  it('GET /tenants/:t/campaigns -> liste avec compteurs', async () => {
    const app = appWith(new FakeRepo(contacts));
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/campaigns', ...auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ campaigns: Array<{ name: string; counts: { total: number } }> }>();
    expect(body.campaigns[0]?.name).toBe('Promo');
    expect(body.campaigns[0]?.counts.total).toBe(2);
    await app.close();
  });

  it('GET campagne connue -> détail + destinataires', async () => {
    const app = appWith(new FakeRepo(contacts));
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/campaigns/known', ...auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; recipients: Array<{ status: string }> }>();
    expect(body.status).toBe('completed');
    expect(body.recipients[0]?.status).toBe('sent');
    await app.close();
  });

  it('GET campagne inconnue -> 404', async () => {
    const app = appWith(new FakeRepo(contacts));
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/campaigns/nope', ...auth() });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET numéros du tenant -> liste', async () => {
    const app = appWith(new FakeRepo(contacts));
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/phone-numbers', ...auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ phoneNumbers: Array<{ id: string }> }>();
    expect(body.phoneNumbers[0]?.id).toBe('pn1');
    await app.close();
  });

  it('GET campagnes tenant != token -> 403', async () => {
    const app = appWith(new FakeRepo(contacts));
    const res = await app.inject({ method: 'GET', url: '/tenants/AUTRE/campaigns', ...auth() });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('GET campagnes sans token -> 401', async () => {
    const app = appWith(new FakeRepo(contacts));
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/campaigns' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
