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
  templateName: 'promo', templateLanguage: 'fr', paramMapping: [], status: 'draft', workflowId: null, ratePerMinute: null,
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

  it('campagne WORKFLOW : startWorkflow reçoit les params résolus du 1er template (5e arg)', async () => {
    const captured: string[][] = [];
    const wf: Campaign = { ...campaign, workflowId: 'wf1', templateName: '' };
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: ['Julie'], status: 'pending' },
    ]);
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        getCampaign: async () => wf,
        recipients,
        startWorkflow: async (_t, _w, _waId, _cid, params) => { captured.push(params); },
      }),
    );
    expect(report.sent).toBe(1);
    expect(captured).toEqual([['Julie']]);
  });

  it('débit PAR CAMPAGNE : ratePerMinute posé -> RateLimiter d intervalle ceil(60000/rate), acquire avant chaque envoi', async () => {
    const intervals: number[] = [];
    let acquires = 0;
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
      { id: 'r2', contactId: 'y', toE164: '+33622', resolvedParams: [], status: 'pending' },
    ]);
    const staticGate = { acquire: async () => { throw new Error('le limiteur statique ne doit PAS être utilisé quand un débit par campagne est posé'); } };
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        getCampaign: async () => ({ ...campaign, ratePerMinute: 30 }),
        recipients,
        rateLimiter: staticGate, // doit être IGNORÉ au profit du limiteur par campagne
        makeRateLimiter: (ms) => { intervals.push(ms); return { acquire: async () => { acquires += 1; } }; },
      }),
    );
    expect(report.sent).toBe(2);
    expect(intervals).toEqual([2000]); // ceil(60000/30) = 2000 ms, un SEUL limiteur construit pour le run
    expect(acquires).toBe(2); // une acquisition par destinataire
  });

  it('débit PAR CAMPAGNE : ratePerMinute null -> aucun limiteur par campagne, le limiteur statique (s il existe) est utilisé', async () => {
    let made = 0;
    let acquires = 0;
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
    ]);
    await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        getCampaign: async () => ({ ...campaign, ratePerMinute: null }),
        recipients,
        rateLimiter: { acquire: async () => { acquires += 1; } },
        makeRateLimiter: () => { made += 1; return { acquire: async () => {} }; },
      }),
    );
    expect(made).toBe(0); // pas de débit -> pas de limiteur par campagne construit
    expect(acquires).toBe(1); // le limiteur statique fourni est utilisé tel quel
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
