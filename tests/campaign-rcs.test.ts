import { describe, it, expect } from 'vitest';
import { runCampaign } from '../src/campaign/engine';
import type { EngineDeps, RecipientStore, CampaignStore, FrequencyStore, QualityProvider } from '../src/campaign/engine';
import { makeCampaignSender } from '../src/campaign/sender';
import type { Campaign, Recipient, QualityRating } from '../src/campaign/types';
import { RcsSender } from '../src/rcs/sender';
import { Reachability } from '../src/rcs/reachability';
import type { ReachabilityStore } from '../src/rcs/reachability';
import { FakeRcsProvider } from '../src/rcs/fake';

class SansCache implements ReachabilityStore {
  async get() {
    return null;
  }
  async put() {
    /* rien */
  }
}

function rcsSender(nonJoignables: string[] = []) {
  const provider = new FakeRcsProvider({ unreachable: new Set(nonJoignables) });
  const sender = new RcsSender(provider, new Reachability(provider, new SansCache(), () => 0), {
    isOptedOut: async () => false,
  });
  return { provider, sender };
}

function campaignSender(nonJoignables: string[] = []) {
  const { provider, sender } = rcsSender(nonJoignables);
  return {
    provider,
    channelSender: makeCampaignSender({
      channel: 'rcs',
      tenantId: 't1',
      agentId: 'agent-1',
      message: { kind: 'text', text: 'Offre du jour' },
      rcs: sender,
    }),
  };
}

const campagne: Campaign = {
  id: 'c1',
  tenantId: 't1',
  phoneNumberId: '', // campagne RCS : aucun numéro Meta
  category: 'marketing',
  templateName: '',
  templateLanguage: '',
  paramMapping: [],
  status: 'draft',
  workflowId: null,
  startNodeId: null,
  ratePerMinute: null,
  channel: 'rcs',
};

function rec(id: string, toE164: string): Recipient {
  return { id, contactId: `ct-${id}`, toE164, resolvedParams: [], status: 'pending' };
}

class FakeRecipients implements RecipientStore {
  readonly results = new Map<string, { status: string; messageId?: string; error?: string }>();
  constructor(private readonly pending: Recipient[]) {}
  async listPending(): Promise<Recipient[]> {
    return this.pending;
  }
  async claim(): Promise<boolean> {
    return true;
  }
  async markResult(id: string, r: { status: 'sent' | 'failed' | 'skipped'; messageId?: string; error?: string }) {
    this.results.set(id, r);
  }
}
class FakeCampaigns implements CampaignStore {
  readonly statuses: string[] = [];
  async setStatus(_id: string, s: Campaign['status']) {
    this.statuses.push(s);
  }
}
class FakeFreq implements FrequencyStore {
  async lastSentAt() {
    return null;
  }
  async record() {
    /* rien */
  }
}
/** Le quality rating est une notion META. Cette sonde échoue si le moteur l'interroge sur une campagne RCS. */
class QualityInterdite implements QualityProvider {
  appels = 0;
  async getRating(): Promise<QualityRating> {
    this.appels++;
    return 'GREEN';
  }
}

function deps(over: Partial<EngineDeps> & { recipients: RecipientStore }): EngineDeps {
  return {
    sender: {
      sendMarketing: async () => {
        throw new Error('le sender Meta ne doit JAMAIS etre appele sur une campagne RCS');
      },
      sendTemplate: async () => {
        throw new Error('le sender Meta ne doit JAMAIS etre appele sur une campagne RCS');
      },
    },
    campaigns: new FakeCampaigns(),
    frequency: new FakeFreq(),
    quality: new QualityInterdite(),
    now: () => 1_000_000_000,
    ...over,
  };
}

describe('CampaignSender RCS', () => {
  it('envoie aux joignables et saute les autres', async () => {
    const { provider, channelSender } = campaignSender(['+33600000001']);
    const ok = await channelSender.sendTo(rec('r1', '+33600000002'));
    const ko = await channelSender.sendTo(rec('r2', '+33600000001'));
    expect(ok).toEqual({ messageId: 'r1' });
    expect(ko).toEqual({ skipped: 'not_rcs_reachable' });
    expect(provider.sent.map((s) => s.e164)).toEqual(['+33600000002']);
  });

  it('utilise l id du destinataire comme messageId (idempotence sur rejeu)', async () => {
    const { provider, channelSender } = campaignSender();
    await channelSender.sendTo(rec('r1', '+33600000002'));
    await channelSender.sendTo(rec('r1', '+33600000002'));
    expect(provider.sent).toHaveLength(1);
  });
});

describe('runCampaign sur le canal RCS', () => {
  it('envoie par le sender de canal, compte les non joignables en skipped', async () => {
    const { provider, channelSender } = campaignSender(['+33600000001']);
    const recipients = new FakeRecipients([rec('r1', '+33600000002'), rec('r2', '+33600000001')]);
    const campaigns = new FakeCampaigns();
    const report = await runCampaign(campagne, deps({ recipients, channelSender, campaigns }));

    expect(report).toMatchObject({ sent: 1, skipped: 1, failed: 0, paused: false });
    expect(recipients.results.get('r1')).toMatchObject({ status: 'sent', messageId: 'r1' });
    expect(recipients.results.get('r2')).toMatchObject({ status: 'skipped', error: 'not_rcs_reachable' });
    expect(provider.sent.map((s) => s.e164)).toEqual(['+33600000002']);
    expect(campaigns.statuses).toEqual(['running', 'completed']);
  });

  it('n interroge JAMAIS le quality rating Meta sur une campagne RCS', async () => {
    const { channelSender } = campaignSender();
    const quality = new QualityInterdite();
    await runCampaign(campagne, deps({ recipients: new FakeRecipients([rec('r1', '+33600000002')]), channelSender, quality }));
    expect(quality.appels).toBe(0);
  });

  it('ne lit JAMAIS le carousel ni l en-tete media du template sur une campagne RCS', async () => {
    const { channelSender } = campaignSender();
    let lectures = 0;
    await runCampaign(
      campagne,
      deps({
        recipients: new FakeRecipients([rec('r1', '+33600000002')]),
        channelSender,
        getTemplateCarousel: async () => {
          lectures++;
          return null;
        },
        getTemplateHeaderMedia: async () => {
          lectures++;
          return null;
        },
      }),
    );
    expect(lectures).toBe(0);
  });
});
