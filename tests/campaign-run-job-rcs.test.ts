import { describe, it, expect } from 'vitest';
import { campaignRunJob } from '../src/campaign/run-job';
import type { RunJobDeps } from '../src/campaign/run-job';
import type { MessageSender, RecipientStore, CampaignStore, FrequencyStore, QualityProvider } from '../src/campaign/engine';
import type { CampaignSender } from '../src/campaign/sender';
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
  async getRating(): Promise<QualityRating> {
    return 'GREEN';
  }
}

const campagneRcs: Campaign = {
  id: 'c1',
  tenantId: 't1',
  phoneNumberId: '',
  category: 'marketing',
  templateName: '',
  templateLanguage: '',
  paramMapping: [],
  status: 'draft',
  workflowId: null,
  startNodeId: null,
  ratePerMinute: null,
  channel: 'rcs',
  rcsAgentId: 'agent-1',
  rcsMessage: { kind: 'text', text: 'Offre du jour' },
};

function senderRcs(nonJoignables: string[] = []) {
  const provider = new FakeRcsProvider({ unreachable: new Set(nonJoignables) });
  const rcs = new RcsSender(provider, new Reachability(provider, new SansCache(), () => 0), {
    isOptedOut: async () => false,
  });
  return { provider, rcs };
}

function deps(over: Partial<RunJobDeps> & { recipients: RecipientStore }): RunJobDeps {
  return {
    getCampaign: async () => campagneRcs,
    senderFor: async (): Promise<MessageSender> => {
      throw new Error('senderFor (Meta) ne doit JAMAIS etre resolu sur une campagne RCS');
    },
    campaigns: new FakeCampaigns(),
    frequency: new FakeFreq(),
    quality: new FakeQuality(),
    ...over,
  } as RunJobDeps;
}

function rec(id: string, toE164: string): Recipient {
  return { id, contactId: `ct-${id}`, toE164, resolvedParams: [], status: 'pending' };
}

describe('campaignRunJob sur le canal RCS', () => {
  it('envoie par le sender de canal, sans jamais resoudre le token Meta', async () => {
    const { provider, rcs } = senderRcs();
    const channelSender: CampaignSender = makeCampaignSender({
      channel: 'rcs', tenantId: 't1', agentId: 'agent-1',
      message: { kind: 'text', text: 'Offre du jour' }, rcs,
    });
    const recipients = new FakeRecipients([rec('r1', '+33600000002')]);
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({ recipients, rcsSenderFor: async () => channelSender }),
    );
    expect(report).toMatchObject({ sent: 1, failed: 0, paused: false });
    expect(provider.sent.map((s) => s.e164)).toEqual(['+33600000002']);
  });

  it('ne verifie PAS l appartenance du numero Meta sur une campagne RCS', async () => {
    const { rcs } = senderRcs();
    const channelSender = makeCampaignSender({
      channel: 'rcs', tenantId: 't1', agentId: 'agent-1',
      message: { kind: 'text', text: 'Offre du jour' }, rcs,
    });
    let verifs = 0;
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        recipients: new FakeRecipients([rec('r1', '+33600000002')]),
        rcsSenderFor: async () => channelSender,
        phoneNumberBelongsToTenant: async () => {
          verifs++;
          return false; // un phoneNumberId vide ne peut appartenir à personne
        },
      }),
    );
    expect(verifs).toBe(0);
    expect(report).toMatchObject({ sent: 1, paused: false });
  });

  it('met la campagne en PAUSE avec une raison quand le canal RCS n est pas cable', async () => {
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({ recipients: new FakeRecipients([rec('r1', '+33600000002')]) }),
    );
    expect(report.paused).toBe(true);
    expect(report.reason).toContain('RCS');
    expect(report.sent).toBe(0);
  });

  it('met la campagne en PAUSE quand l agent RCS est introuvable', async () => {
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({ recipients: new FakeRecipients([rec('r1', '+33600000002')]), rcsSenderFor: async () => null }),
    );
    expect(report.paused).toBe(true);
    expect(report.reason).toContain('agent');
    expect(report.sent).toBe(0);
  });
});
