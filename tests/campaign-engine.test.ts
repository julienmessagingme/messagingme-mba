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
  templateName: 'promo', templateLanguage: 'fr', paramMapping: [], status: 'draft', workflowId: null, ratePerMinute: null, startNodeId: null,
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

  /**
   * Un run de workflow qui NE DÉMARRE PAS ne doit JAMAIS être compté comme envoyé (revue Lot D).
   *
   * Le trou : `startWorkflow` renvoyait void, donc le moteur posait un messageId synthétique et marquait `sent`
   * quoi qu'il arrive. Une campagne pouvait afficher « 500 envoyés, 0 échec » alors que 0 message était parti
   * (fil repris par un opérateur, scénario supprimé, ou devenu non lançable après édition).
   */
  it('campagne WORKFLOW : un run NON démarré (false) -> destinataire `failed` avec raison, jamais `sent`', async () => {
    const wf: Campaign = { ...campaign, workflowId: 'wf1' };
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    const report = await runCampaign(wf, deps({
      recipients,
      // r1 ne démarre pas (ex. fil repris par un opérateur), r2 démarre normalement.
      startWorkflow: async (_t, _w, waId) => waId !== '33611',
    }));
    expect(report).toMatchObject({ sent: 1, failed: 1 });
    expect(recipients.results.get('r1')).toMatchObject({ status: 'failed' });
    expect(recipients.results.get('r1')?.error).toMatch(/non lançable/);
    expect(recipients.results.get('r2')).toMatchObject({ status: 'sent' });
  });

  /**
   * Refus décidé À L'INTÉRIEUR du scénario (visuel de carte non préparable, variable sans valeur, template
   * introuvable chez Meta). La raison doit atterrir SUR le destinataire : sinon elle n'existe que dans les
   * logs du worker et l'écran affiche « envoyé » alors que rien n'est parti (vécu 3 fois le 2026-08-15).
   */
  it('campagne WORKFLOW : la RAISON du refus atterrit sur le destinataire, pas seulement dans les logs', async () => {
    const wf: Campaign = { ...campaign, workflowId: 'wf1' };
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const report = await runCampaign(wf, deps({
      recipients,
      startWorkflow: async () => 'template « promo » : l’image de la carte 2 n’a pas pu être préparée pour l’envoi',
    }));
    expect(report).toMatchObject({ sent: 0, failed: 1 });
    expect(recipients.results.get('r1')?.error).toContain('carte 2');
  });

  it('campagne NODE : un run NON démarré (false) -> `failed`, jamais `sent`', async () => {
    const node: Campaign = { ...campaign, workflowId: 'wf1', startNodeId: 'n5', templateName: '' };
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const report = await runCampaign(node, deps({
      recipients,
      startWorkflowFromNode: async () => false, // bloc de départ disparu entre la création et l'exécution
    }));
    expect(report).toMatchObject({ sent: 0, failed: 1 });
    expect(recipients.results.get('r1')).toMatchObject({ status: 'failed' });
  });

  it('un câblage qui renvoie void reste traité comme un démarrage réussi (rétro-compatibilité)', async () => {
    const wf: Campaign = { ...campaign, workflowId: 'wf1' };
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const report = await runCampaign(wf, deps({
      recipients,
      startWorkflow: async () => { /* void : ne sait pas dire s'il a démarré */ },
    }));
    expect(report).toMatchObject({ sent: 1, failed: 0 });
  });

  // Aiguillage des 3 formes de campagne (cible node de /v1/sends, D-1).
  it('campagne NODE (workflowId + startNodeId) : passe par startWorkflowFromNode, PAS par startWorkflow', async () => {
    const fromNode: string[] = [];
    const classic: string[] = [];
    const sender = new FakeSender();
    const node: Campaign = { ...campaign, workflowId: 'wf1', startNodeId: 'n5', templateName: '' };
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', 'BSUID_xyz')]);
    const report = await runCampaign(node, deps({
      recipients, sender,
      startWorkflow: async (_t, wf, waId) => { classic.push(`${wf}:${waId}`); },
      startWorkflowFromNode: async (_t, wf, nodeId, waId, cid) => { fromNode.push(`${wf}:${nodeId}:${waId}:${cid}`); },
    }));
    expect(report).toMatchObject({ sent: 2, failed: 0 });
    expect(classic).toEqual([]); // l'entrée du scénario n'est JAMAIS rejouée
    expect(fromNode).toEqual(['wf1:n5:33611:ct-r1', 'wf1:n5:BSUID_xyz:ct-r2']); // waId = chiffres nus, BSUID intact
    expect(sender.calls).toEqual([]); // aucun envoi de template en direct
  });

  it('campagne WORKFLOW SEUL (startNodeId null) : comportement INCHANGÉ (startWorkflow)', async () => {
    const fromNode: string[] = [];
    const classic: string[] = [];
    const wf: Campaign = { ...campaign, workflowId: 'wf1' };
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    await runCampaign(wf, deps({
      recipients,
      startWorkflow: async (_t, w, waId) => { classic.push(`${w}:${waId}`); },
      startWorkflowFromNode: async () => { fromNode.push('NE DEVRAIT PAS ÊTRE APPELÉ'); },
    }));
    expect(classic).toEqual(['wf1:33611']);
    expect(fromNode).toEqual([]);
  });

  it('campagne TEMPLATE (ni workflow ni node) : comportement INCHANGÉ (envoi direct)', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    await runCampaign(campaign, deps({
      recipients, sender,
      startWorkflow: async () => { throw new Error('ne doit pas être appelé'); },
      startWorkflowFromNode: async () => { throw new Error('ne doit pas être appelé'); },
    }));
    expect(sender.calls).toHaveLength(1);
  });

  it('campagne NODE sans startWorkflowFromNode câblé -> destinataire failed (jamais d’envoi silencieux)', async () => {
    const node: Campaign = { ...campaign, workflowId: 'wf1', startNodeId: 'n5', templateName: '' };
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const report = await runCampaign(node, deps({ recipients }));
    expect(report).toMatchObject({ sent: 0, failed: 1 });
  });

  it('fréquence : un contact envoyé récemment est skippé QUAND le cap est activé (fenêtre > 0)', async () => {
    // Le cap est désactivé par défaut (DEFAULT_THRESHOLDS.frequencyWindowMs = 0) : on l'active explicitement
    // ici pour valider que le garde-fou saute bien un contact récent quand une fenêtre est configurée.
    const sender = new FakeSender();
    const frequency = new FakeFreq();
    frequency.map.set('+33611', 1_000_000_000 - 1000); // < 24h
    const thresholds: GuardrailThresholds = { frequencyWindowMs: 24 * 3600 * 1000, maxFailureRate: 0.3, minSendsForFailureCheck: 20 };
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    const report = await runCampaign(campaign, deps({ recipients, sender, frequency, thresholds }));
    expect(report).toMatchObject({ sent: 1, skipped: 1 });
    expect(sender.calls).toEqual(['+33622']);
    // Skip fréquence TRANSITOIRE : non persisté (reste 'pending' pour un futur run).
    expect(recipients.results.has('r1')).toBe(false);
    expect(recipients.claimed).toEqual(['r2']); // r1 non claimé (skippé avant le claim)
  });

  it('fréquence : DÉSACTIVÉE par défaut -> un contact récent est quand même envoyé', async () => {
    // DEFAULT_THRESHOLDS.frequencyWindowMs = 0 (pilote) : même un envoi marketing récent ne bloque plus.
    const sender = new FakeSender();
    const frequency = new FakeFreq();
    frequency.map.set('+33611', 1_000_000_000 - 1000); // envoi récent, mais cap désactivé
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    const report = await runCampaign(campaign, deps({ recipients, sender, frequency }));
    expect(report).toMatchObject({ sent: 2, skipped: 0 });
    expect(sender.calls).toEqual(['+33611', '+33622']);
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

describe('runCampaign — template CAROUSEL', () => {
  /** Sender qui capture le TemplateSpec réellement envoyé (marketing + template). */
  class CapturingSender implements MessageSender {
    readonly specs: TemplateSpec[] = [];
    async sendMarketing(p: MarketingParams): Promise<SendResult> {
      this.specs.push(p.template);
      return { messageId: 'm1' };
    }
    async sendTemplate(_to: string, tpl: TemplateSpec): Promise<SendResult> {
      this.specs.push(tpl);
      return { messageId: 'm1' };
    }
  }
  const cards = [{ mediaId: 'mid-a' }, { mediaId: 'mid-b' }];

  it('joint le composant carousel à l envoi, et ne relit le template QU UNE FOIS par run', async () => {
    const sender = new CapturingSender();
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    let reads = 0;
    const report = await runCampaign(campaign, deps({
      recipients, sender,
      getTemplateCarousel: async () => { reads += 1; return { cards }; },
    }));
    expect(report).toMatchObject({ sent: 2, failed: 0 });
    expect(reads).toBe(1); // JAMAIS un appel Meta par destinataire (une campagne à 5 000 contacts le paierait)
    expect(sender.specs).toHaveLength(2);
    for (const spec of sender.specs) {
      const carousel = (spec.components as Array<{ type: string; cards?: unknown[] }>).find((c) => c.type === 'carousel');
      expect(carousel?.cards).toHaveLength(2);
    }
  });

  it('carousel non envoyable -> chaque destinataire en ÉCHEC avec la vraie raison, AUCUN envoi', async () => {
    const sender = new CapturingSender();
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const report = await runCampaign(campaign, deps({
      recipients, sender,
      getTemplateCarousel: async () => ({ cards: [{ body: 'carte sans image' }] }),
    }));
    expect(report).toMatchObject({ sent: 0, failed: 1 });
    expect(sender.specs).toHaveLength(0); // rien n'est parti
    const res = recipients.results.get('r1');
    expect(res?.status).toBe('failed');
    expect(res?.error).toContain('Carousel non envoyable');
    expect(res?.error).toContain('carte 1');
  });

  it('carousel refusé sur 25 destinataires -> AUCUNE pause (le quality gate ne voit pas 100 % d échecs)', async () => {
    // Piège : passer par la boucle d envoi ferait compter 20 échecs, puis le quality gate mettrait la campagne
    // en pause avec « taux d échec 100 % » et laisserait les 5 derniers en attente. Diagnostic trompeur.
    const sender = new CapturingSender();
    const list = Array.from({ length: 25 }, (_, i) => rec(`r${i}`, `+3361100${i}`));
    const recipients = new FakeRecipients(list);
    const campaigns = new FakeCampaigns();
    const report = await runCampaign(campaign, deps({
      recipients, sender, campaigns,
      getTemplateCarousel: async () => ({ cards: [{ body: 'carte sans image' }] }),
    }));
    expect(report).toMatchObject({ sent: 0, failed: 25, paused: false });
    expect(report.reason).toBeUndefined();
    expect(sender.specs).toHaveLength(0);
    expect(campaigns.statuses).toEqual(['running', 'completed']); // jamais 'paused'
    for (const r of list) expect(recipients.results.get(r.id)?.status).toBe('failed');
  });

  it('lecture du template en erreur -> la campagne part quand même (template sans carousel non affecté)', async () => {
    const sender = new CapturingSender();
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const report = await runCampaign(campaign, deps({
      recipients, sender,
      getTemplateCarousel: async () => { throw new Error('réseau'); },
    }));
    expect(report).toMatchObject({ sent: 1, failed: 0 });
    expect(sender.specs[0]!.components).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'X' }] }]);
  });

  it('campagne SCÉNARIO : aucune lecture de template (c est le scénario qui envoie)', async () => {
    let reads = 0;
    const wf: Campaign = { ...campaign, workflowId: 'wf1' };
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    await runCampaign(wf, deps({
      recipients,
      startWorkflow: async () => true,
      getTemplateCarousel: async () => { reads += 1; return null; },
    }));
    expect(reads).toBe(0);
  });
});
