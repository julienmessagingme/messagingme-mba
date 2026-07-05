import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import type { CampaignRepoLike } from '../src/campaign/create';
import type { CreateCampaignInput } from '../src/campaign/store.pg';
import type { BuildContact, BuiltRecipient } from '../src/campaign/build';

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

describe('POST /tenants/:tenantId/campaigns', () => {
  it('crée la campagne et construit les destinataires (opt-in filtré)', async () => {
    const repo = new FakeRepo(contacts);
    const app = buildServer({
      queue: new FakeQueue(),
      campaigns: { repo, queue: new FakeQueue(), campaignExists: async () => true },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/campaigns',
      headers: { 'content-type': 'application/json' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ campaignId: string; recipientCount: number }>();
    expect(body).toEqual({ campaignId: 'camp-1', recipientCount: 1 }); // c2 non opt-in exclu (marketing)
    expect(repo.created[0]?.tenantId).toBe('t1');
    await app.close();
  });

  it('category invalide -> 400', async () => {
    const repo = new FakeRepo(contacts);
    const app = buildServer({
      queue: new FakeQueue(),
      campaigns: { repo, queue: new FakeQueue(), campaignExists: async () => true },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/campaigns',
      headers: { 'content-type': 'application/json' },
      payload: { ...validBody, category: 'promo' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('champ requis manquant -> 400', async () => {
    const repo = new FakeRepo(contacts);
    const app = buildServer({
      queue: new FakeQueue(),
      campaigns: { repo, queue: new FakeQueue(), campaignExists: async () => true },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/campaigns',
      headers: { 'content-type': 'application/json' },
      payload: { ...validBody, templateName: '' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('paramMapping invalide (positions non contiguës) -> 400, rien inséré', async () => {
    const repo = new FakeRepo(contacts);
    const app = buildServer({
      queue: new FakeQueue(),
      campaigns: { repo, queue: new FakeQueue(), campaignExists: async () => true },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/campaigns',
      headers: { 'content-type': 'application/json' },
      payload: { ...validBody, paramMapping: [{ position: 5, source: { type: 'literal', value: 'x' } }] },
    });
    expect(res.statusCode).toBe(400);
    expect(repo.created).toHaveLength(0); // pas de campagne orpheline
    await app.close();
  });
});

describe('POST /campaigns/:campaignId/run', () => {
  it('campagne connue -> 202 + job campaign-run enqueué', async () => {
    const q = new FakeQueue();
    const repo = new FakeRepo(contacts);
    const app = buildServer({
      queue: new FakeQueue(),
      campaigns: { repo, queue: q, campaignExists: async (id) => id === 'known' },
    });
    const res = await app.inject({ method: 'POST', url: '/campaigns/known/run' });
    expect(res.statusCode).toBe(202);
    expect(q.enqueued).toEqual([{ name: 'campaign-run', data: { campaignId: 'known' } }]);
    await app.close();
  });

  it('campagne inconnue -> 404, rien enqueué', async () => {
    const q = new FakeQueue();
    const repo = new FakeRepo(contacts);
    const app = buildServer({
      queue: new FakeQueue(),
      campaigns: { repo, queue: q, campaignExists: async () => false },
    });
    const res = await app.inject({ method: 'POST', url: '/campaigns/nope/run' });
    expect(res.statusCode).toBe(404);
    expect(q.enqueued).toEqual([]);
    await app.close();
  });
});
