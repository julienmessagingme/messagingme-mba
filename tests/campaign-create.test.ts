import { describe, it, expect } from 'vitest';
import { createCampaignWithRecipients } from '../src/campaign/create';
import type { CampaignRepoLike } from '../src/campaign/create';
import type { CreateCampaignInput } from '../src/campaign/store.pg';
import type { BuildContact, BuiltRecipient } from '../src/campaign/build';

class FakeRepo implements CampaignRepoLike {
  lastRecipients: BuiltRecipient[] = [];
  constructor(private readonly contacts: BuildContact[]) {}
  async listContactsForBuild(): Promise<BuildContact[]> {
    return this.contacts;
  }
  async createWithRecipients(_input: CreateCampaignInput, recipients: BuiltRecipient[]): Promise<{ campaignId: string; recipientCount: number }> {
    this.lastRecipients = recipients;
    return { campaignId: 'camp-x', recipientCount: recipients.length };
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
    expect(out).toEqual({ campaignId: 'camp-x', recipientCount: 1, skipped: [] });
    expect(repo.lastRecipients).toHaveLength(1);
    expect(repo.lastRecipients[0]).toMatchObject({ contactId: 'c1', toE164: '+33611', resolvedParams: ['Julie'] });
  });

  it('variable manquante -> contact SAUTÉ (skipped) + non persisté (pré-validation)', async () => {
    const repo = new FakeRepo([
      { id: 'ok', phone_e164: '+33611', fields: { prenom: 'Marie' }, optInStatus: 'opted_in' },
      { id: 'ko', phone_e164: '+33622', fields: {}, optInStatus: 'opted_in' },
    ]);
    const prenomInput: CreateCampaignInput = { ...input, paramMapping: [{ position: 1, source: { type: 'field', key: 'prenom' } }] };
    const out = await createCampaignWithRecipients(prenomInput, repo);
    expect(out.recipientCount).toBe(1);
    expect(out.skipped).toEqual([{ contactId: 'ko', toE164: '+33622', reason: 'missing_variable', missing: [1] }]);
    expect(repo.lastRecipients.map((r) => r.contactId)).toEqual(['ok']);
  });

  it('utility : inclut les contacts sans opt-in explicite', async () => {
    const repo = new FakeRepo([
      { id: 'c1', phone_e164: '+33611', profile_name: 'Julie', fields: {}, optInStatus: 'unknown' },
    ]);
    const out = await createCampaignWithRecipients({ ...input, category: 'utility' }, repo);
    expect(out.recipientCount).toBe(1);
  });

  it('contactIds : restreint aux contacts choisis', async () => {
    const repo = new FakeRepo([
      { id: 'c1', phone_e164: '+33611', profile_name: 'Julie', fields: {}, optInStatus: 'opted_in' },
      { id: 'c2', phone_e164: '+33622', profile_name: 'Marc', fields: {}, optInStatus: 'opted_in' },
      { id: 'c3', phone_e164: '+33633', profile_name: 'Lea', fields: {}, optInStatus: 'opted_in' },
    ]);
    const out = await createCampaignWithRecipients({ ...input, contactIds: ['c1', 'c3'] }, repo);
    expect(out.recipientCount).toBe(2);
    expect(repo.lastRecipients.map((r) => r.contactId)).toEqual(['c1', 'c3']);
  });

  it('contactIds vide : retombe sur tous les contacts', async () => {
    const repo = new FakeRepo([
      { id: 'c1', phone_e164: '+33611', profile_name: 'Julie', fields: {}, optInStatus: 'opted_in' },
      { id: 'c2', phone_e164: '+33622', profile_name: 'Marc', fields: {}, optInStatus: 'opted_in' },
    ]);
    const out = await createCampaignWithRecipients({ ...input, contactIds: [] }, repo);
    expect(out.recipientCount).toBe(2);
  });

  it('contactIds : l\'opt-in reste appliqué (choisir un opted_out ne force pas l\'envoi)', async () => {
    const repo = new FakeRepo([
      { id: 'c1', phone_e164: '+33611', profile_name: 'Julie', fields: {}, optInStatus: 'opted_out' },
    ]);
    const out = await createCampaignWithRecipients({ ...input, contactIds: ['c1'] }, repo);
    expect(out.recipientCount).toBe(0);
  });
});
