import { describe, it, expect } from 'vitest';
import { runCampaign } from '../src/campaign/engine';
import type {
  MessageSender,
  RecipientStore,
  CampaignStore,
  FrequencyStore,
  QualityProvider,
  EngineDeps,
} from '../src/campaign/engine';
import type { Campaign, Recipient, QualityRating, GuardrailThresholds } from '../src/campaign/types';
import type { SendResult, MarketingParams, TemplateSpec } from '../src/meta/types';
import { MetaApiError } from '../src/meta/errors';

class FakeSender implements MessageSender {
  readonly calls: string[] = [];
  readonly marketingCalls: string[] = [];
  readonly marketingParams: MarketingParams[] = [];
  readonly templateCalls: string[] = [];
  failFor: Set<string> = new Set();
  async sendMarketing(p: MarketingParams): Promise<SendResult> {
    const to = p.to ?? p.recipient ?? '';
    if (this.failFor.has(to)) throw new MetaApiError(400, { code: 131049, message: 'blocked' });
    this.calls.push(to);
    this.marketingCalls.push(to);
    this.marketingParams.push(p);
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
  readonly results = new Map<string, { status: string; messageId?: string; error?: string; sentAt?: number; errorCode?: number }>();
  readonly claimed: string[] = [];
  /** ids pour lesquels l'écriture `sent` throw (panne de persistance après envoi réussi). */
  throwSentFor: Set<string> = new Set();
  /** ids déjà pris par un autre run (claim -> false). */
  claimFails: Set<string> = new Set();
  constructor(private readonly pending: Recipient[]) {}
  async listPending(): Promise<Recipient[]> {
    return this.pending;
  }
  async claim(id: string): Promise<boolean> {
    if (this.claimFails.has(id)) return false;
    this.claimed.push(id);
    return true;
  }
  async markResult(
    id: string,
    r: { status: 'sent' | 'failed' | 'skipped'; messageId?: string; error?: string; sentAt?: number; errorCode?: number },
  ): Promise<void> {
    if (r.status === 'sent' && this.throwSentFor.has(id)) throw new Error('db down');
    this.results.set(id, r);
  }
}
class FakeCampaigns implements CampaignStore {
  readonly statuses: string[] = [];
  async setStatus(_id: string, status: string): Promise<void> {
    this.statuses.push(status);
  }
}
class FakeFreq implements FrequencyStore {
  readonly map = new Map<string, number>();
  async lastSentAt(_t: string, key: string): Promise<number | null> {
    return this.map.get(key) ?? null;
  }
  async record(_t: string, key: string, atMs: number): Promise<void> {
    this.map.set(key, atMs);
  }
}
class FakeQuality implements QualityProvider {
  constructor(public rating: QualityRating = 'GREEN') {}
  async getRating(): Promise<QualityRating> {
    return this.rating;
  }
}

const campaign: Campaign = {
  id: 'c1', tenantId: 't1', phoneNumberId: 'pn1', category: 'marketing',
  templateName: 'promo', templateLanguage: 'fr', paramMapping: [], status: 'draft', workflowId: null,
};
function rec(id: string, to: string, status: Recipient['status'] = 'pending'): Recipient {
  return { id, contactId: `ct-${id}`, toE164: to, resolvedParams: ['X'], status };
}
function deps(over: Partial<EngineDeps> & { recipients: RecipientStore }): EngineDeps {
  return {
    sender: new FakeSender(),
    campaigns: new FakeCampaigns(),
    frequency: new FakeFreq(),
    quality: new FakeQuality(),
    now: () => 1_000_000_000,
    ...over,
  };
}

describe('runCampaign', () => {
  it('envoie à tous les pending, enregistre les message ids, statut completed', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    const campaigns = new FakeCampaigns();
    const report = await runCampaign(campaign, deps({ recipients, sender, campaigns }));
    expect(report).toMatchObject({ sent: 2, skipped: 0, failed: 0, paused: false });
    expect(sender.calls).toEqual(['+33611', '+33622']);
    expect(recipients.results.get('r1')).toMatchObject({ status: 'sent', messageId: 'm-+33611' });
    expect(campaigns.statuses).toEqual(['running', 'completed']);
  });

  it('destinataire BSUID (marketing) -> routé en `recipient`, jamais `to`', async () => {
    const sender = new FakeSender();
    // r1 = numéro E.164 -> to ; r2 = BSUID -> recipient.
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', 'BSUID_xyz')]);
    await runCampaign(campaign, deps({ recipients, sender }));
    expect(sender.marketingParams[0]).toMatchObject({ to: '+33611' });
    expect(sender.marketingParams[0]!.recipient).toBeUndefined();
    expect(sender.marketingParams[1]).toMatchObject({ recipient: 'BSUID_xyz' });
    expect(sender.marketingParams[1]!.to).toBeUndefined();
  });

  it('campagne WORKFLOW : le wa_id passé = chiffres nus pour un numéro, BSUID intact', async () => {
    const started: Array<{ waId: string }> = [];
    const wf: Campaign = { ...campaign, workflowId: 'wf1' };
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', 'BSUID_xyz')]);
    await runCampaign(wf, deps({
      recipients,
      startWorkflow: async (_t, _w, waId) => { started.push({ waId }); },
    }));
    expect(started.map((s) => s.waId)).toEqual(['33611', 'BSUID_xyz']); // numéro -> chiffres nus, BSUID intact
  });

  it('campagne WORKFLOW : passe r.resolvedParams (variables du 1er template) à startWorkflow', async () => {
    // rec() pose resolvedParams: ['X'] -> chaque destinataire doit transmettre SES params résolus au 5e arg.
    const captured: string[][] = [];
    const wf: Campaign = { ...campaign, workflowId: 'wf1' };
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    await runCampaign(wf, deps({
      recipients,
      startWorkflow: async (_t, _w, _waId, _cid, params) => { captured.push(params); },
    }));
    expect(captured).toEqual([['X'], ['X']]);
  });

  it('fréquence : un contact envoyé récemment est skippé', async () => {
    const sender = new FakeSender();
    const frequency = new FakeFreq();
    frequency.map.set('+33611', 1_000_000_000 - 1000); // < 24h
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    const report = await runCampaign(campaign, deps({ recipients, sender, frequency }));
    expect(report).toMatchObject({ sent: 1, skipped: 1 });
    expect(sender.calls).toEqual(['+33622']);
    // Skip fréquence TRANSITOIRE : non persisté (reste 'pending' pour un futur run).
    expect(recipients.results.has('r1')).toBe(false);
    expect(recipients.claimed).toEqual(['r2']); // r1 non claimé (skippé avant le claim)
  });

  it('claim échoue (run concurrent) : le destinataire est sauté, aucun envoi', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    recipients.claimFails = new Set(['r1']); // r1 déjà pris par un autre run
    const report = await runCampaign(campaign, deps({ recipients, sender }));
    expect(sender.calls).toEqual(['+33622']); // r1 jamais envoyé
    expect(report.sent).toBe(1);
  });

  it('utility : la fréquence ne s applique pas (message de service)', async () => {
    const sender = new FakeSender();
    const frequency = new FakeFreq();
    frequency.map.set('+33611', 1_000_000_000 - 1000); // envoi marketing récent
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const util: Campaign = { ...campaign, category: 'utility' };
    const report = await runCampaign(util, deps({ recipients, sender, frequency }));
    expect(report).toMatchObject({ sent: 1, skipped: 0 }); // envoyé malgré la fréquence
    expect(sender.templateCalls).toEqual(['+33611']);
  });

  it('idempotent : un recipient déjà sent est sauté', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([rec('r1', '+33611', 'sent'), rec('r2', '+33622')]);
    const report = await runCampaign(campaign, deps({ recipients, sender }));
    expect(report.sent).toBe(1);
    expect(sender.calls).toEqual(['+33622']);
  });

  it('quality RED : pause immédiate, aucun envoi, statut paused', async () => {
    const sender = new FakeSender();
    const campaigns = new FakeCampaigns();
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    const report = await runCampaign(campaign, deps({ recipients, sender, campaigns, quality: new FakeQuality('RED') }));
    expect(report.paused).toBe(true);
    expect(report.reason).toMatch(/RED/);
    expect(sender.calls).toEqual([]);
    expect(campaigns.statuses).toEqual(['running', 'paused']);
  });

  it('échec Meta sur un destinataire -> failed + report exact', async () => {
    const sender = new FakeSender();
    sender.failFor = new Set(['+33611']);
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    const report = await runCampaign(campaign, deps({ recipients, sender }));
    expect(report).toMatchObject({ sent: 1, failed: 1 });
    // Le code Meta (131049) est isolé et transmis à markResult -> alimente le breakdown d'erreurs.
    expect(recipients.results.get('r1')).toMatchObject({ status: 'failed', errorCode: 131049 });
    expect(recipients.results.get('r2')).toMatchObject({ status: 'sent' });
  });

  it('campagne WORKFLOW : démarre le workflow par destinataire (pas d\'envoi template direct), marque sent', async () => {
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    const sender = new FakeSender();
    const started: string[] = [];
    const wfCampaign = { ...campaign, workflowId: 'wf1', templateName: '' };
    const report = await runCampaign(wfCampaign, deps({
      recipients, sender,
      startWorkflow: async (_t, wf, waId, cid) => { started.push(`${wf}:${waId}:${cid}`); },
    }));
    expect(report).toMatchObject({ sent: 2, failed: 0 });
    expect(sender.calls).toEqual([]); // aucun envoi de template en direct : c'est le workflow qui envoie
    expect(started).toEqual(['wf1:33611:ct-r1', 'wf1:33622:ct-r2']); // waId = chiffres, contactId transmis
    expect(recipients.results.get('r1')).toMatchObject({ status: 'sent' });
  });

  it('taux d échec au-delà du seuil -> pause moteur + arrêt des destinataires restants', async () => {
    // seuil bas : après 3 échecs (rate 100% > 30%, total 3 >= min 3), le gate coupe.
    const T: GuardrailThresholds = { frequencyWindowMs: 1000, maxFailureRate: 0.3, minSendsForFailureCheck: 3 };
    const sender = new FakeSender();
    sender.failFor = new Set(['+331', '+332', '+333']);
    const recipients = new FakeRecipients([
      rec('r1', '+331'), rec('r2', '+332'), rec('r3', '+333'),
      rec('r4', '+334'), rec('r5', '+335'),
    ]);
    const report = await runCampaign(campaign, deps({ recipients, sender, thresholds: T }));
    expect(report.paused).toBe(true);
    expect(report.reason).toMatch(/taux d'échec/);
    expect(report).toMatchObject({ sent: 0, failed: 3 });
    // r4/r5 jamais tentés (ni envoi, ni marquage) : la coupure arrête tout le reste.
    expect(sender.calls).toEqual([]);
    expect(recipients.results.has('r4')).toBe(false);
    expect(recipients.results.has('r5')).toBe(false);
  });

  it('utility -> route vers sendTemplate (pas sendMarketing)', async () => {
    const sender = new FakeSender();
    const util: Campaign = { ...campaign, category: 'utility' };
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const report = await runCampaign(util, deps({ recipients, sender }));
    expect(report.sent).toBe(1);
    expect(sender.templateCalls).toEqual(['+33611']);
    expect(sender.marketingCalls).toEqual([]);
  });

  it('envoi OK mais persistance `sent` qui throw -> jamais marqué failed, quality gate non pollué', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    recipients.throwSentFor = new Set(['r1']); // le message part, mais l'écriture DB casse
    // L'erreur de persistance remonte (erreur dure) : on NE compte PAS r1 comme échec.
    await expect(runCampaign(campaign, deps({ recipients, sender }))).rejects.toThrow(/db down/);
    expect(sender.marketingCalls).toContain('+33611'); // message réellement envoyé
    expect(recipients.results.get('r1')).toBeUndefined(); // ni 'sent' ni 'failed' persisté
  });
});

type OutboundCall = { tenantId: string; waId: string; msg: { body: string; messageId: string | null; type?: string; templateCategory?: string | null; templateName?: string | null } };

describe('runCampaign — journal du sortant (recordOutbound)', () => {
  function capture(): { calls: OutboundCall[]; recordOutbound: NonNullable<EngineDeps['recordOutbound']> } {
    const calls: OutboundCall[] = [];
    return { calls, recordOutbound: async (tenantId, waId, msg) => { calls.push({ tenantId, waId, msg }); } };
  }

  it('envoi template DIRECT réussi -> logue le sortant (wa_id chiffres nus, template, messageId réel)', async () => {
    const { calls, recordOutbound } = capture();
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    await runCampaign(campaign, deps({ recipients, recordOutbound }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tenantId: 't1', waId: '33611' }); // '+33611' -> chiffres nus (aligné avec l'inbound)
    expect(calls[0]!.msg).toMatchObject({ type: 'template', templateName: 'promo', templateCategory: 'marketing', messageId: 'm-+33611' });
    expect(calls[0]!.msg.body).toContain('promo');
  });

  it('campagne WORKFLOW -> NE logue PAS ici (le vrai template est loggé par le worker)', async () => {
    const { calls, recordOutbound } = capture();
    const wf: Campaign = { ...campaign, workflowId: 'wf1' };
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    await runCampaign(wf, deps({ recipients, recordOutbound, startWorkflow: async () => {} }));
    expect(calls).toHaveLength(0);
  });

  it('envoi ÉCHOUÉ -> pas de log', async () => {
    const { calls, recordOutbound } = capture();
    const sender = new FakeSender();
    sender.failFor = new Set(['+33611']);
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    await runCampaign(campaign, deps({ recipients, sender, recordOutbound }));
    expect(calls).toHaveLength(0);
  });

  it('log BEST-EFFORT : un recordOutbound qui throw ne casse pas l\'envoi (sent quand même)', async () => {
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const report = await runCampaign(campaign, deps({ recipients, recordOutbound: async () => { throw new Error('log down'); } }));
    expect(report.sent).toBe(1);
    expect(recipients.results.get('r1')).toMatchObject({ status: 'sent' });
  });
});
