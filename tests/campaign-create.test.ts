import { describe, it, expect } from 'vitest';
import { createCampaignWithRecipients } from '../src/campaign/create';
import type { CampaignRepoLike } from '../src/campaign/create';
import type { CreateCampaignInput } from '../src/campaign/store.pg';
import type { BuildContact, BuiltRecipient } from '../src/campaign/build';

class FakeRepo implements CampaignRepoLike {
  lastRecipients: BuiltRecipient[] = [];
  constructor(private readonly contacts: BuildContact[]) {}
  async insertCampaign(_input: CreateCampaignInput): Promise<string> {
    return 'camp-x';
  }
  async listContactsForBuild(): Promise<BuildContact[]> {
    return this.contacts;
  }
  async insertRecipients(_id: string, recipients: BuiltRecipient[]): Promise<number> {
    this.lastRecipients = recipients;
    return recipients.length;
  }
}

const input: CreateCampaignInput = {
  tenantId: 't1',
  phoneNumberId: 'pn1',
  name: 'n',
  category: 'marketing',
  templateName: 'promo',
  templateLanguage: 'fr',
  paramMapping: [{ position: 1, source: { type: 'attribute', key: 'name' } }],
};

describe('createCampaignWithRecipients', () => {
  it('construit et persiste les destinataires (opt-in filtré, params résolus)', async () => {
    const repo = new FakeRepo([
      { id: 'c1', phone_e164: '+33611', profile_name: 'Julie', fields: {}, optInStatus: 'opted_in' },
      { id: 'c2', phone_e164: '+33622', profile_name: 'Marc', fields: {}, optInStatus: 'unknown' },
    ]);
    const out = await createCampaignWithRecipients(input, repo);
    expect(out).toEqual({ campaignId: 'camp-x', recipientCount: 1 });
    expect(repo.lastRecipients).toHaveLength(1);
    expect(repo.lastRecipients[0]).toMatchObject({ contactId: 'c1', toE164: '+33611', resolvedParams: ['Julie'] });
  });

  it('utility : inclut les contacts sans opt-in explicite', async () => {
    const repo = new FakeRepo([
      { id: 'c1', phone_e164: '+33611', profile_name: 'Julie', fields: {}, optInStatus: 'unknown' },
    ]);
    const out = await createCampaignWithRecipients({ ...input, category: 'utility' }, repo);
    expect(out.recipientCount).toBe(1);
  });
});
