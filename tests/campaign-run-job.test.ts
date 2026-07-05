import { describe, it, expect } from 'vitest';
import { campaignRunJob } from '../src/campaign/run-job';
import type { RunJobDeps } from '../src/campaign/run-job';
import type {
  MessageSender,
  RecipientStore,
  CampaignStore,
  FrequencyStore,
  QualityProvider,
} from '../src/campaign/engine';
import type { Campaign, Recipient, QualityRating } from '../src/campaign/types';
import type { SendResult, MarketingParams, TemplateSpec } from '../src/meta/types';
import { MetaApiError } from '../src/meta/errors';

class FakeSender implements MessageSender {
  readonly calls: string[] = [];
  readonly marketingCalls: string[] = [];
  readonly templateCalls: string[] = [];
  failFor: Set<string> = new Set();
  async sendMarketing(p: MarketingParams): Promise<SendResult> {
    const to = p.to ?? p.recipient ?? '';
    if (this.failFor.has(to)) throw new MetaApiError(400, { code: 131049, message: 'blocked' });
    this.calls.push(to);
    this.marketingCalls.push(to);
    return { messageId: `m-${to}` };
  }
  async sendTemplate(to: string, _tpl: TemplateSpec): Promise<SendResult> {
    if (this.failFor.has(to)) throw new MetaApiError(400, { code: 131049, message: 'blocked' });
    this.calls.push(to);
    this.templateCalls.push(to);
    return { messageId: `m-${to}` };
  }
}
class FakeRecipients implements RecipientStore {
  readonly results = new Map<string, { status: string }>();
  constructor(private readonly pending: Recipient[]) {}
  async listPending(): Promise<Recipient[]> {
    return this.pending;
  }
  async claim(): Promise<boolean> {
    return true;
  }
  async markResult(id: string, r: { status: 'sent' | 'failed' | 'skipped' }): Promise<void> {
    this.results.set(id, { status: r.status });
  }
}
class FakeCampaigns implements CampaignStore {
  async setStatus(): Promise<void> {}
}
class FakeFreq implements FrequencyStore {
  async lastSentAt(): Promise<number | null> {
    return null;
  }
  async record(): Promise<void> {}
}
class FakeQuality implements QualityProvider {
  constructor(private readonly rating: QualityRating = 'GREEN') {}
  async getRating(): Promise<QualityRating> {
    return this.rating;
  }
}

const campaign: Campaign = {
  id: 'c1', tenantId: 't1', phoneNumberId: 'pn1', category: 'marketing',
  templateName: 'promo', templateLanguage: 'fr', paramMapping: [], status: 'draft',
};

function deps(over: Partial<RunJobDeps> & { getCampaign: RunJobDeps['getCampaign'] }): RunJobDeps {
  return {
    senderFor: () => new FakeSender(),
    recipients: new FakeRecipients([]),
    campaigns: new FakeCampaigns(),
    frequency: new FakeFreq(),
    quality: new FakeQuality(),
    ...over,
  };
}

describe('campaignRunJob', () => {
  it('charge la campagne et exécute le run -> report exact', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
      { id: 'r2', contactId: 'y', toE164: '+33622', resolvedParams: [], status: 'pending' },
    ]);
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({ getCampaign: async () => campaign, senderFor: () => sender, recipients }),
    );
    expect(report).toMatchObject({ sent: 2, failed: 0, paused: false });
    expect(sender.calls).toEqual(['+33611', '+33622']);
  });

  it('campagne utility -> route via sendTemplate à travers l assemblage run-job', async () => {
    const sender = new FakeSender();
    const util: Campaign = { ...campaign, category: 'utility' };
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
    ]);
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({ getCampaign: async () => util, senderFor: () => sender, recipients }),
    );
    expect(report.sent).toBe(1);
    expect(sender.templateCalls).toEqual(['+33611']);
    expect(sender.marketingCalls).toEqual([]);
  });

  it('échec sender -> destinataire failed + report exact via run-job', async () => {
    const sender = new FakeSender();
    sender.failFor = new Set(['+33611']);
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
      { id: 'r2', contactId: 'y', toE164: '+33622', resolvedParams: [], status: 'pending' },
    ]);
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({ getCampaign: async () => campaign, senderFor: () => sender, recipients }),
    );
    expect(report).toMatchObject({ sent: 1, failed: 1 });
    expect(recipients.results.get('r1')).toMatchObject({ status: 'failed' });
    expect(recipients.results.get('r2')).toMatchObject({ status: 'sent' });
  });

  it('campagne inconnue -> throw', async () => {
    await expect(
      campaignRunJob({ campaignId: 'nope' }, deps({ getCampaign: async () => null })),
    ).rejects.toThrow(/inconnue/);
  });

  it('payload sans campaignId -> throw', async () => {
    await expect(
      campaignRunJob({}, deps({ getCampaign: async () => campaign })),
    ).rejects.toThrow(/campaignId/);
  });
});
