import { describe, it, expect } from 'vitest';
import { runCampaign, etageServable } from '../src/campaign/engine';
import type {
  MessageSender,
  RecipientStore,
  CampaignStore,
  FrequencyStore,
  QualityProvider,
  EngineDeps,
  TentativeEnvoi,
} from '../src/campaign/engine';
import type { Campaign, Recipient, QualityRating, GuardrailThresholds } from '../src/campaign/types';
import type { Etage } from '../src/campaign/etages';
import type { SendResult, MarketingParams, TemplateSpec } from '../src/meta/types';
import { MetaApiError } from '../src/meta/errors';
import type { MotifDePause } from '../src/campaign/pause';

class FakeSender implements MessageSender {
  readonly calls: string[] = [];
  readonly marketingCalls: string[] = [];
  readonly marketingParams: MarketingParams[] = [];
  readonly templateCalls: string[] = [];
  failFor: Set<string> = new Set();
  /** Destinataires sur lesquels Meta repond un PLAFOND DU NUMERO (130429 par defaut). */
  plafondFor: Set<string> = new Set();
  codePlafond = 130429;
  async sendMarketing(p: MarketingParams): Promise<SendResult> {
    const to = p.to ?? p.recipient ?? '';
    if (this.plafondFor.has(to)) throw new MetaApiError(400, { code: this.codePlafond, message: 'rate limit hit' });
    if (this.failFor.has(to)) throw new MetaApiError(400, { code: 131049, message: 'blocked' });
    this.calls.push(to);
    this.marketingCalls.push(to);
    this.marketingParams.push(p);
    return { messageId: `m-${to}` };
  }
  async sendTemplate(to: string, _tpl: TemplateSpec): Promise<SendResult> {
    if (this.plafondFor.has(to)) throw new MetaApiError(400, { code: this.codePlafond, message: 'rate limit hit' });
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
  /** Destinataires RENDUS a la file (l'inverse de claim). Le plafond de numero est le seul a s'en servir. */
  readonly relaches: string[] = [];
  async relacher(id: string): Promise<void> {
    this.relaches.push(id);
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
  /** Raisons de pause vues, avec leur instant de reprise. `null` = pas de reprise automatique. */
  readonly pauses: Array<{ raison: string; reprise: Date | null }> = [];
  async setStatus(_id: string, status: string, pause?: { raison: MotifDePause; reprise: Date | null }): Promise<void> {
    if (pause) this.pauses.push(pause);
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
/** Sender qui capture le TemplateSpec réellement envoyé (marketing + template). Partagé par les blocs qui
 *  vérifient le PAYLOAD (carousel, en-tête média) : un second exemplaire divergerait au premier changement. */
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

/**
 * En-tête média : un template dont Meta a approuvé un en-tête IMAGE/VIDEO/DOCUMENT exige ce média à CHAQUE
 * envoi. Le 2026-08-17, la campagne « Test Napo » est partie sans, et Meta a refusé 2 destinataires sur 2
 * en 132012. Ces cas verrouillent le refus AVANT la boucle, et le média réellement joint quand il est prêt.
 */
describe('runCampaign : en-tête média du template', () => {
  it('media id prêt -> un composant header avec l’ID, lu UNE seule fois pour tous les destinataires', async () => {
    const sender = new CapturingSender();
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    let reads = 0;
    const report = await runCampaign(campaign, deps({
      recipients, sender,
      getTemplateHeaderMedia: async () => { reads += 1; return { headerFormat: 'IMAGE' as const, mediaId: 'MID-1' }; },
    }));
    expect(report).toMatchObject({ sent: 2, failed: 0 });
    expect(reads).toBe(1); // le visuel est identique pour tous : jamais un re-téléversement par destinataire
    for (const spec of sender.specs) {
      expect(spec.components).toContainEqual({ type: 'header', parameters: [{ type: 'image', image: { id: 'MID-1' } }] });
    }
  });

  it('🔴 média non préparé -> AUCUN envoi, chaque destinataire en échec avec la raison lisible', async () => {
    const sender = new CapturingSender();
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    const report = await runCampaign(campaign, deps({
      recipients, sender,
      getTemplateHeaderMedia: async () => ({ headerFormat: 'IMAGE' as const, mediaId: null }),
    }));
    expect(report).toMatchObject({ sent: 0, failed: 2 });
    expect(sender.specs).toHaveLength(0); // rien n'est parti : plus de 132012 collectionnés un par un
    const res = recipients.results.get('r1');
    expect(res?.status).toBe('failed');
    expect(res?.error).toContain('Template non envoyable');
    expect(res?.error).toContain('image');
  });

  it('refus sur 25 destinataires -> AUCUNE pause (le quality gate ne voit pas 100 % d’échecs)', async () => {
    const sender = new CapturingSender();
    const list = Array.from({ length: 25 }, (_, i) => rec(`r${i}`, `+3361100${i}`));
    const recipients = new FakeRecipients(list);
    const campaigns = new FakeCampaigns();
    const report = await runCampaign(campaign, deps({
      recipients, sender, campaigns,
      getTemplateHeaderMedia: async () => ({ headerFormat: 'IMAGE' as const, mediaId: null }),
    }));
    expect(report).toMatchObject({ sent: 0, failed: 25, paused: false });
    expect(campaigns.statuses).toEqual(['running', 'completed']); // jamais 'paused'
  });

  it('template SANS en-tête média -> envoi inchangé, aucun composant header ajouté', async () => {
    const sender = new CapturingSender();
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const report = await runCampaign(campaign, deps({ recipients, sender, getTemplateHeaderMedia: async () => null }));
    expect(report).toMatchObject({ sent: 1, failed: 0 });
    expect(sender.specs[0]!.components).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'X' }] }]);
  });

  it('lecture en erreur -> la campagne part quand même (un template sans visuel ne doit pas être bloqué)', async () => {
    const sender = new CapturingSender();
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const report = await runCampaign(campaign, deps({
      recipients, sender,
      getTemplateHeaderMedia: async () => { throw new Error('réseau'); },
    }));
    expect(report).toMatchObject({ sent: 1, failed: 0 });
  });

  it('campagne SCÉNARIO ou template à carousel -> aucune lecture d’en-tête (elle n’a pas de sens)', async () => {
    let reads = 0;
    const lecture = async () => { reads += 1; return { headerFormat: 'IMAGE' as const, mediaId: 'M' }; };
    await runCampaign({ ...campaign, workflowId: 'wf1' }, deps({
      recipients: new FakeRecipients([rec('r1', '+33611')]),
      startWorkflow: async () => true,
      getTemplateHeaderMedia: lecture,
    }));
    expect(reads).toBe(0);
    // Un carousel porte ses visuels PAR CARTE : lire un en-tête top-level en plus enverrait un composant de trop.
    await runCampaign(campaign, deps({
      recipients: new FakeRecipients([rec('r2', '+33622')]),
      sender: new CapturingSender(),
      getTemplateCarousel: async () => ({ cards: [{ mediaId: 'C1' }] }),
      getTemplateHeaderMedia: lecture,
    }));
    expect(reads).toBe(0);
  });
});

/**
 * Campagne AU FIL DE L'EAU : sa file vide ne veut PAS dire qu'elle est finie, elle attend son prochain
 * arrivant. La marquer `completed` la couperait de son webhook, puisque seules les campagnes `running` sont
 * alimentées, et plus aucun lead ne serait contacté sans que rien ne le signale.
 */
describe('runCampaign : campagne alimentée par un webhook', () => {
  const auFilDeLEau: Campaign = { ...campaign, webhookId: 'wh1' };

  it('🔴 reste RUNNING au lieu de passer completed, même après avoir tout envoyé', async () => {
    const campaigns = new FakeCampaigns();
    const report = await runCampaign(auFilDeLEau, deps({
      recipients: new FakeRecipients([rec('r1', '+33611')]),
      campaigns,
    }));
    expect(report.sent).toBe(1);
    expect(campaigns.statuses).toEqual(['running', 'running']);
    expect(campaigns.statuses).not.toContain('completed');
  });

  it('🔴 reste RUNNING aussi quand un run ne trouve aucun destinataire (le cas le plus fréquent)', async () => {
    const campaigns = new FakeCampaigns();
    await runCampaign(auFilDeLEau, deps({ recipients: new FakeRecipients([]), campaigns }));
    expect(campaigns.statuses).toEqual(['running', 'running']);
  });

  it("🔴 reste RUNNING même quand le template est injouable (l'adresse doit continuer d'alimenter)", async () => {
    const campaigns = new FakeCampaigns();
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    // Carousel non envoyable : le run écarte tout le monde AVANT la boucle, par un chemin de sortie distinct.
    await runCampaign(auFilDeLEau, deps({
      recipients,
      campaigns,
      getTemplateCarousel: async () => ({ cards: [] }),
    }));
    expect(recipients.results.get('r1')).toMatchObject({ status: 'failed' });
    expect(campaigns.statuses).toEqual(['running', 'running']);
  });

  it("contrôle : une campagne ORDINAIRE se termine toujours (la règle ne déborde pas)", async () => {
    const campaigns = new FakeCampaigns();
    await runCampaign(campaign, deps({ recipients: new FakeRecipients([rec('r1', '+33611')]), campaigns }));
    expect(campaigns.statuses).toEqual(['running', 'completed']);
  });

  it("le quality gate garde le dernier mot : une campagne au fil de l'eau se met bien en pause", async () => {
    const campaigns = new FakeCampaigns();
    const report = await runCampaign(auFilDeLEau, deps({
      recipients: new FakeRecipients([rec('r1', '+33611')]),
      campaigns,
      quality: new FakeQuality('RED'),
    }));
    expect(report.paused).toBe(true);
    expect(campaigns.statuses).toEqual(['running', 'paused']);
  });
});

/**
 * ARRÊT D'URGENCE (R13). Avant ce lot, écrire `paused` en base n'arrêtait rien : la boucle ne relisait jamais
 * le statut, donc une erreur de ciblage sur 5 000 destinataires partait jusqu'au bout.
 *
 * `FakeCampaigns` ne porte PAS `getStatus` : c'est voulu. Toute la suite ci-dessus s'exécute donc sans la
 * moindre relecture, ce qui vérifie au passage que la dépendance optionnelle absente laisse le comportement
 * historique intact.
 */
class FakeCampaignsRelisibles implements CampaignStore {
  readonly statuses: string[] = [];
  /** Statuts servis à la relecture, dans l'ordre. Le dernier vaut pour toutes les relectures suivantes. */
  constructor(private readonly file: Array<Campaign['status']>) {}
  readonly lues: Array<{ id: string; tenantId: string }> = [];
  async setStatus(_id: string, status: string): Promise<void> {
    this.statuses.push(status);
  }
  async getStatus(campaignId: string, tenantId: string): Promise<Campaign['status'] | null> {
    this.lues.push({ id: campaignId, tenantId });
    return this.file[Math.min(this.lues.length - 1, this.file.length - 1)] ?? null;
  }
}

describe('runCampaign : arrêt demandé pendant l’envoi', () => {
  it('🔴 la campagne passée en pause pendant le run S’ARRÊTE : les destinataires suivants ne sont ni claimés ni envoyés', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622'), rec('r3', '+33633')]);
    // running au 1er contrôle, paused ensuite. statusPollMs: 0 -> un contrôle par destinataire (horloge figée).
    const campaigns = new FakeCampaignsRelisibles(['running', 'paused']);
    const report = await runCampaign(campaign, deps({ recipients, sender, campaigns, statusPollMs: 0 }));
    expect(report).toMatchObject({ sent: 1, paused: true });
    expect(report.reason).toContain('pause');
    expect(sender.calls).toEqual(['+33611']);
    expect(recipients.claimed).toEqual(['r1']); // r2 et r3 restent `pending` -> « Reprendre » repart là
    // Le statut N'EST PAS réécrit en sortant : `paused` est la décision de l'opérateur, la réécrire l'écraserait
    // (et `completed` mentirait sur une campagne dont il reste des destinataires).
    expect(campaigns.statuses).toEqual(['running']);
    expect(campaigns.lues).toEqual([{ id: 'c1', tenantId: 't1' }, { id: 'c1', tenantId: 't1' }]);
  });

  it('contrôle en sens inverse : statut resté `running` -> la campagne va jusqu’au bout et se termine', async () => {
    const sender = new FakeSender();
    const campaigns = new FakeCampaignsRelisibles(['running']);
    const report = await runCampaign(campaign, deps({
      recipients: new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]),
      sender, campaigns, statusPollMs: 0,
    }));
    expect(report).toMatchObject({ sent: 2, paused: false });
    expect(sender.calls).toEqual(['+33611', '+33622']);
    expect(campaigns.statuses).toEqual(['running', 'completed']);
  });

  it('campagne DISPARUE en cours de route (relecture null) : le run continue, on n’invente pas un arrêt', async () => {
    const campaigns = new FakeCampaignsRelisibles([null as unknown as Campaign['status']]);
    const report = await runCampaign(campaign, deps({
      recipients: new FakeRecipients([rec('r1', '+33611')]),
      campaigns, statusPollMs: 0,
    }));
    expect(report).toMatchObject({ sent: 1, paused: false });
  });

  it('🔴 le contrôle est cadencé par le TEMPS, pas par destinataire : horloge figée -> aucune relecture', async () => {
    // Sans cadence, ce serait une requête par destinataire, soit 5 000 sur une grosse campagne. Avec une
    // cadence en NOMBRE de destinataires, une campagne à 1 msg/min mettrait des heures à voir la pause.
    const campaigns = new FakeCampaignsRelisibles(['paused']);
    const report = await runCampaign(campaign, deps({
      recipients: new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622'), rec('r3', '+33633')]),
      campaigns, // pas de statusPollMs -> défaut 5 s, et `deps()` fige l'horloge : le pas n'est jamais atteint
    }));
    expect(campaigns.lues).toEqual([]);
    expect(report.sent).toBe(3);
  });
});

/**
 * R4 : UN DÉPLOIEMENT NE DOIT PLUS GELER UNE CAMPAGNE.
 *
 * Le worker est tué en plein envoi à chaque `up -d` (SIGKILL vers 10 s, un run de deux heures n'a aucune
 * chance). Le moteur doit donc savoir sortir proprement, SANS toucher au statut : la campagne reste `running`
 * avec ses destinataires en attente, et le balayage de reprise la relance au redémarrage. La marquer `paused`
 * demanderait un geste humain pour repartir, alors que personne n'a rien décidé.
 */
describe('runCampaign : arrêt du service et bail du verrou', () => {
  it('🔴 arrêt demandé : le destinataire suivant n’est NI claimé NI envoyé, et le statut n’est pas réécrit', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622'), rec('r3', '+33633')]);
    const campaigns = new FakeCampaigns();
    let arret = false;
    const report = await runCampaign(campaign, deps({
      recipients, sender, campaigns,
      // On coupe APRÈS le premier envoi, comme un SIGTERM en plein run.
      arretDemande: () => { const v = arret; arret = true; return v; },
    }));
    expect(report).toMatchObject({ sent: 1, paused: true });
    expect(report.reason).toContain('arrêt du service');
    expect(sender.calls).toEqual(['+33611']);
    expect(recipients.claimed).toEqual(['r1']); // r2 et r3 restent `pending` pour la reprise
    // 🔴 `running` et RIEN d'autre : ni `completed` (il reste du monde), ni `paused` (personne n'a décidé).
    expect(campaigns.statuses).toEqual(['running']);
  });

  it('contrôle : sans arrêt demandé, le run va jusqu’au bout (la garde ne déborde pas)', async () => {
    const sender = new FakeSender();
    const report = await runCampaign(campaign, deps({
      recipients: new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]),
      sender, arretDemande: () => false,
    }));
    expect(report).toMatchObject({ sent: 2, paused: false });
  });

  it('🔴 le bail du verrou est RENOUVELÉ à la cadence de la relecture de statut', async () => {
    // Sans renouvellement, le bail devrait couvrir la durée entière du run (des heures) et un worker tué
    // bloquerait la reprise pendant tout ce temps : c'est exactement le gel que R4 supprime.
    let renouvellements = 0;
    const campaigns = new FakeCampaignsRelisibles(['running']);
    const report = await runCampaign(campaign, deps({
      recipients: new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]),
      campaigns, statusPollMs: 0,
      renouvelerVerrou: async () => { renouvellements += 1; return true; },
    }));
    expect(report.sent).toBe(2);
    expect(renouvellements).toBe(2);
  });

  it('🔴 bail PERDU : le run s’arrête, sinon deux runs enverraient en parallèle', async () => {
    const sender = new FakeSender();
    const campaigns = new FakeCampaignsRelisibles(['running']);
    const report = await runCampaign(campaign, deps({
      recipients: new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]),
      sender, campaigns, statusPollMs: 0,
      renouvelerVerrou: async () => false,
    }));
    expect(report).toMatchObject({ sent: 0, paused: true });
    expect(report.reason).toContain('verrou');
    expect(sender.calls).toEqual([]);
  });
});

/**
 * PLAFOND DU NUMÉRO (lot 1 du programme, 2026-08-31). `130429` et `131048` n'étaient dans aucune des deux
 * listes de `src/meta/errors.ts`, donc traités par le défaut « 4xx sans code connu = terminal ». Une limite
 * TEMPORAIRE brûlait donc l'audience restante d'une campagne, destinataire par destinataire, définitivement.
 */
describe('runCampaign : plafond du numéro chez Meta', () => {
  it('🔴 met la campagne en PAUSE et rend le destinataire à la file, au lieu de le brûler', async () => {
    const sender = new FakeSender();
    sender.plafondFor.add('+33622');
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622'), rec('r3', '+33633')]);
    const campaigns = new FakeCampaigns();
    const report = await runCampaign(campaign, deps({ recipients, sender, campaigns }));

    expect(report.paused).toBe(true);
    expect(report.reason).toContain('plafond Meta');
    expect(report.failed).toBe(0); // personne n'est en échec : le refus visait le NUMÉRO
    expect(recipients.results.get('r2')).toBeUndefined(); // r2 n'est ni sent, ni failed
    expect(recipients.relaches).toEqual(['r2']); // il est RENDU à la file
    expect(campaigns.statuses).toEqual(['running', 'paused']);
  });

  it('🔴 le reste de l’audience n’est PAS parcouru : le suivant échouerait pareil', async () => {
    const sender = new FakeSender();
    sender.plafondFor.add('+33622');
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622'), rec('r3', '+33633')]);
    await runCampaign(campaign, deps({ recipients, sender }));
    // r1 est parti, r2 a heurté le plafond, r3 n'a même pas été tenté.
    expect(sender.calls).toEqual(['+33611']);
    expect(recipients.claimed).toEqual(['r1', 'r2']);
  });

  it('131048 (plafond de qualité) met AUSSI en pause, mais SANS reprise automatique', async () => {
    // 🔴 La distinction du lot 0103. Les deux mettent la campagne en pause et ne perdent personne, mais la
    // QUALITÉ n'a pas d'instant de reprise : Meta juge le numéro, pas la cadence, et relancer sans rien
    // changer aggrave le problème et peut coûter le numéro. `reprise: null` est ce qui rend la campagne
    // invisible au balayage de reprise.
    const sender = new FakeSender();
    sender.codePlafond = 131048;
    sender.plafondFor.add('+33611');
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const campaigns = new FakeCampaigns();
    const report = await runCampaign(campaign, deps({ recipients, sender, campaigns }));
    expect(report.paused).toBe(true);
    expect(recipients.relaches).toEqual(['r1']);
    expect(campaigns.statuses).toEqual(['running', 'paused']);
    expect(campaigns.pauses).toEqual([{ raison: 'qualite', reprise: null }]);
    expect(report.reason).toMatch(/n'est PAS automatique/);
  });

  it('🔴 130429 (plafond de DÉBIT) pose un instant de reprise : c’est lui qui fait repartir la campagne', async () => {
    // L'autre sens, et il compte autant : sans instant, le balayage ne verrait jamais cette campagne et la
    // reprise resterait le clic manuel que le texte affiché promettait déjà à tort.
    const sender = new FakeSender();
    sender.codePlafond = 130429;
    sender.plafondFor.add('+33611');
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const campaigns = new FakeCampaigns();
    const report = await runCampaign(campaign, deps({ recipients, sender, campaigns }));
    expect(campaigns.pauses).toHaveLength(1);
    expect(campaigns.pauses[0]!.raison).toBe('debit');
    expect(campaigns.pauses[0]!.reprise).toBeInstanceOf(Date);
    expect(report.reason).toMatch(/Reprise automatique/);
  });

  it('⚠️ 131056 (plafond de la PAIRE) reste un échec de destinataire, PAS une pause', async () => {
    // Il dit « trop de messages entre ce numéro et CE contact ». Mettre la campagne en pause pour un seul
    // contact arrêterait 5 000 envois légitimes.
    const sender = new FakeSender();
    sender.codePlafond = 131056;
    sender.plafondFor.add('+33611');
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    const campaigns = new FakeCampaigns();
    const report = await runCampaign(campaign, deps({ recipients, sender, campaigns }));
    expect(report.paused).toBe(false);
    expect(report.failed).toBe(1);
    expect(report.sent).toBe(1); // r2 est parti : la campagne a continué
    expect(recipients.relaches).toEqual([]);
    expect(campaigns.statuses).toEqual(['running', 'completed']);
  });

  it('une erreur ORDINAIRE reste un échec de destinataire (aucune régression)', async () => {
    const sender = new FakeSender();
    sender.failFor.add('+33611');
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    const report = await runCampaign(campaign, deps({ recipients, sender }));
    expect(report).toMatchObject({ sent: 1, failed: 1, paused: false });
    expect(recipients.results.get('r1')).toMatchObject({ status: 'failed', errorCode: 131049 });
    expect(recipients.relaches).toEqual([]);
  });
});

/**
 * LOTS COURTS (lot 5 du programme, 2026-08-31).
 *
 * Sans découpage, un job traitait sa campagne jusqu'à épuisement : 5 000 destinataires à 30/min, c'est 2 h 47
 * pendant lesquelles la file `campaign-run` ne sert PERSONNE d'autre. Le run rend désormais la main sur une
 * DURÉE, et l'appelant le réenfile.
 */
describe('runCampaign : lots bornés par la durée', () => {
  /** Horloge qui avance de `pas` à chaque lecture : la durée est donc franchie après quelques appels. */
  const horloge = (pas: number) => {
    let t = 1_000_000_000;
    return () => { t += pas; return t; };
  };

  it('🔴 le run s’arrête sur sa durée, annonce qu’il RESTE du travail, et ne touche pas au statut', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622'), rec('r3', '+33633')]);
    const campaigns = new FakeCampaigns();
    // 10 s par lecture d'horloge, durée max 1 ms : la sortie tombe dès que du travail a été fait.
    const report = await runCampaign(campaign, deps({ recipients, sender, campaigns, dureeMaxMs: 1, now: horloge(10_000) }));

    expect(report.reste).toBe(true);
    expect(report.paused).toBe(false); // ce n'est PAS une pause : personne n'a rien décidé
    expect(report.sent).toBeGreaterThanOrEqual(1);
    expect(report.sent).toBeLessThan(3); // ...et tout n'est pas parti
    // La campagne reste `running` : pas de `completed`, pas de `paused`. C'est ce qui permet de la reprendre.
    expect(campaigns.statuses).toEqual(['running']);
  });

  it('🔴 la sortie n’est JAMAIS prise avant d’avoir traité quelqu’un (sinon la file tourne à vide)', async () => {
    // Un run qui sortirait AVANT d'avoir envoyé quoi que ce soit se réenfilerait sans fin, sans jamais
    // progresser : une file qui tourne à vide pour l'éternité. La garde est `traites > 0`.
    const sender = new FakeSender();
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    const report = await runCampaign(campaign, deps({ recipients, sender, dureeMaxMs: 1, now: horloge(10_000) }));
    expect(report.sent).toBe(1); // le premier destinataire part TOUJOURS
    expect(report.reste).toBe(true); // et c'est seulement APRÈS que le lot rend la main
  });

  it('durée à 0 = découpage RETIRÉ (même sens que dans l’environnement), pas « couper tout de suite »', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    const report = await runCampaign(campaign, deps({ recipients, sender, dureeMaxMs: 0, now: horloge(10_000) }));
    expect(report.sent).toBe(2);
    expect(report.reste).toBeUndefined();
  });

  it('sans durée injectée -> aucun découpage (comportement d’avant, e2e et fixtures)', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622'), rec('r3', '+33633')]);
    const campaigns = new FakeCampaigns();
    const report = await runCampaign(campaign, deps({ recipients, sender, campaigns, now: horloge(10_000) }));
    expect(report.sent).toBe(3);
    expect(report.reste).toBeUndefined();
    expect(campaigns.statuses).toEqual(['running', 'completed']);
  });

  it('durée NON atteinte -> la campagne va au bout et se termine', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    const campaigns = new FakeCampaigns();
    const report = await runCampaign(campaign, deps({ recipients, sender, campaigns, dureeMaxMs: 10 * 60_000, now: horloge(1) }));
    expect(report.sent).toBe(2);
    expect(report.reste).toBeUndefined();
    expect(campaigns.statuses).toEqual(['running', 'completed']);
  });
});

/**
 * FIN DE CAMPAGNE ET DESTINATAIRE EN VOL (mesuré au banc de charge le 2026-09-01).
 *
 * 🔴 Ce que ce test protège est une perte SILENCIEUSE et DÉFINITIVE. Un `kill -9` du worker en plein envoi
 * laisse le destinataire en cours à l'état `sending`. Le run suivant ne le voit pas (`listPending` ne rend que
 * les `pending`), vide la file et marque la campagne `completed`. Dix minutes plus tard, `reclaimStale` le
 * remet en `pending`... sur une campagne TERMINÉE, que la reprise ne relance plus. Ce contact ne recevait
 * jamais son message, et les compteurs affichaient « 399 sur 400 » avec une campagne « terminée ».
 */
describe('moteur : ne pas clore une campagne avec un destinataire en vol', () => {
  function socle(sending: number) {
    const statuts: string[] = [];
    return {
      statuts,
      campaigns: {
        setStatus: async (_id: string, s: string) => { statuts.push(s); },
        getStatus: async () => 'running' as const,
      },
      recipients: {
        listPending: async () => [],
        claim: async () => true,
        relacher: async () => {},
        markResult: async () => {},
        countSending: async () => sending,
      },
    };
  }

  it('🔴 un destinataire encore RÉSERVÉ laisse la campagne en cours', async () => {
    const s = socle(1);
    await runCampaign(campaign, s as never);
    expect(s.statuts[s.statuts.length - 1]).toBe('running');
  });

  it('aucun destinataire réservé : la campagne se termine normalement', async () => {
    const s = socle(0);
    await runCampaign(campaign, s as never);
    expect(s.statuts[s.statuts.length - 1]).toBe('completed');
  });
});

/**
 * LA JOIGNABILITÉ WHATSAPP ÉCRITE PAR LE MOTEUR (migration 0133).
 *
 * 🔴 SANS CE CÂBLAGE, LE CHAMP N'EST QU'UNE LISTE NOIRE. Seul le balayage de relance sait écrire « non » :
 * personne n'écrirait jamais « oui », donc aucun écran ne pourrait annoncer une COUVERTURE, seulement une
 * exclusion. C'est la moitié manquante du champ, pas un agrément.
 */
describe('runCampaign : la joignabilité WhatsApp notée à l\'envoi', () => {
  type Note = [string, string, boolean];

  it('un envoi template DIRECT accepté note le contact joignable', async () => {
    const notes: Note[] = [];
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    await runCampaign(campaign, deps({
      recipients,
      noterJoignabilite: async (t, c, j) => { notes.push([t, c, j]); },
    }));
    // Le CONTACT, pas le destinataire : la mémoire vit sur `contacts` et sert au-delà de cette campagne.
    expect(notes).toEqual([['t1', 'ct-r1', true], ['t1', 'ct-r2', true]]);
  });

  it('un envoi en ÉCHEC ne note rien : le moteur n\'écrit que ce qu\'il a mesuré', async () => {
    const notes: Note[] = [];
    const sender = new FakeSender();
    sender.failFor = new Set(['+33622']);
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    await runCampaign(campaign, deps({
      recipients,
      sender,
      noterJoignabilite: async (t, c, j) => { notes.push([t, c, j]); },
    }));
    // 🔴 Et surtout PAS `[..., false]` sur l'échoué : un 131049 dit que Meta a plafonné le marketing, pas que
    // le numéro n'a pas WhatsApp. Le seul « non » légitime est celui du second échec 131026, ailleurs.
    expect(notes).toEqual([['t1', 'ct-r1', true]]);
  });

  it('une campagne de SCÉNARIO ne note rien : son messageId est synthétique, rien n\'est parti d\'ici', async () => {
    const notes: Note[] = [];
    const wf: Campaign = { ...campaign, workflowId: 'wf1' };
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    await runCampaign(wf, deps({
      recipients,
      startWorkflow: async () => true,
      noterJoignabilite: async (t, c, j) => { notes.push([t, c, j]); },
    }));
    expect(notes).toEqual([]);
  });

  it('une campagne RCS ne note rien : joignable en RCS ne dit RIEN de WhatsApp', async () => {
    const notes: Note[] = [];
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    await runCampaign(campaign, deps({
      recipients,
      channelSender: { sendTo: async () => ({ messageId: 'rcs-r1' }) },
      noterJoignabilite: async (t, c, j) => { notes.push([t, c, j]); },
    }));
    expect(notes).toEqual([]);
  });

  it('une note qui throw ne relabellise JAMAIS un message livré', async () => {
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const report = await runCampaign(campaign, deps({
      recipients,
      noterJoignabilite: async () => { throw new Error('base down'); },
    }));
    // Best-effort, exactement comme le journal du fil : le pire coût est un verdict resté `inconnu`.
    expect(report).toMatchObject({ sent: 1, failed: 0 });
    expect(recipients.results.get('r1')).toMatchObject({ status: 'sent' });
  });
});

/**
 * LE JOURNAL DES TENTATIVES ÉCRIT PAR LE MOTEUR (migration 0134).
 *
 * 🔴 CE QUE CE BLOC PROTÈGE, ET QUE LE TEST D'INTÉGRATION NE PEUT PAS PROTÉGER AUSSI BIEN. Le journal est
 * au grain TENTATIVE : il doit s'écrire sur TOUS les chemins de résolution d'un destinataire, y compris les
 * trois qui n'envoient rien. Un chemin oublié ne produit aucune erreur, juste un canal qui semble n'avoir
 * jamais échoué, c'est-à-dire exactement le chiffre sur lequel on déciderait de le remplacer par un autre.
 * Ici les cinq chemins se provoquent à la demande, ce qu'une vraie base rend bien plus difficile.
 */
describe('runCampaign : le journal des tentatives', () => {
  /** Ce que le moteur a voulu journaliser, dans l'ordre. */
  const collecteur = (): { vues: TentativeEnvoi[]; noterEnvoi: EngineDeps['noterEnvoi'] } => {
    const vues: TentativeEnvoi[] = [];
    return { vues, noterEnvoi: async (t) => { vues.push(t); } };
  };

  it('un envoi réussi journalise une tentative `sent`, au rang 1 et sur le canal de la campagne', async () => {
    const { vues, noterEnvoi } = collecteur();
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    await runCampaign(campaign, deps({ recipients, noterEnvoi }));
    expect(vues).toEqual([
      { campaignId: 'c1', recipientId: 'r1', contactId: 'ct-r1', rang: 1, canal: 'whatsapp', statut: 'sent', messageId: 'm-+33611' },
      { campaignId: 'c1', recipientId: 'r2', contactId: 'ct-r2', rang: 1, canal: 'whatsapp', statut: 'sent', messageId: 'm-+33622' },
    ]);
  });

  it('🔴 un ÉCHEC d envoi est journalisé aussi, avec son code Meta', async () => {
    const { vues, noterEnvoi } = collecteur();
    const sender = new FakeSender();
    sender.failFor = new Set(['+33622']);
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    await runCampaign(campaign, deps({ recipients, sender, noterEnvoi }));
    // Le succès ET l'échec : c'est le couple qui fait un funnel, une seule des deux moitiés ne dit rien.
    expect(vues.map((t) => t.statut)).toEqual(['sent', 'failed']);
    expect(vues[1]).toMatchObject({ recipientId: 'r2', statut: 'failed', errorCode: 131049 });
  });

  it('🔴 un destinataire ÉCARTÉ PAR LE CANAL est journalisé `saute`, jamais `failed`', async () => {
    const { vues, noterEnvoi } = collecteur();
    const rcs: Campaign = { ...campaign, channel: 'rcs' };
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    // Le sender de canal rend `{ skipped }` : rien n'est parti et rien n'a raté. C'est aujourd'hui le SEUL
    // producteur de `saute` du moteur, et la nuance décide d'un chiffre : compté en échec, ce canal
    // paraîtrait défaillant alors qu'il n'a rien tenté.
    await runCampaign(rcs, deps({
      recipients, noterEnvoi,
      channelSender: { sendTo: async () => ({ skipped: 'non joignable en RCS' }) },
    }));
    expect(vues).toHaveLength(1);
    expect(vues[0]).toMatchObject({ statut: 'saute', canal: 'rcs' });
  });

  it('🔴 le saut de FRÉQUENCE ne journalise RIEN, et c est essentiel', async () => {
    const { vues, noterEnvoi } = collecteur();
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const report = await runCampaign(campaign, deps({
      recipients, noterEnvoi,
      frequency: { lastSentAt: async () => 1_000_000_000 - 1, record: async () => {} },
      thresholds: { frequencyWindowMs: 3_600_000, maxFailureRate: 1, minSendsForFailureCheck: 999 },
    }));
    // 🔴 CE SAUT-LÀ EST TRANSITOIRE : le destinataire reste `pending` et sera réévalué au run suivant. Le
    // journaliser écrirait une ligne À CHAQUE RUN pour la même personne, donc gonflerait sans fin les
    // compteurs par canal d'un envoi qui n'a jamais eu lieu. Le journal ne note QUE les résolutions.
    expect(report).toMatchObject({ skipped: 1 });
    expect(vues).toEqual([]);
  });

  it('🔴 un scénario qui ne DÉMARRE PAS est journalisé `failed` : rien n est parti', async () => {
    const { vues, noterEnvoi } = collecteur();
    const wf: Campaign = { ...campaign, workflowId: 'wf1' };
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    await runCampaign(wf, deps({ recipients, noterEnvoi, startWorkflow: async () => false }));
    expect(vues).toHaveLength(1);
    expect(vues[0]).toMatchObject({ statut: 'failed' });
  });

  it('🔴 le refus PRÉ-BOUCLE journalise TOUS les destinataires, alors qu aucun n a été tenté', async () => {
    const { vues, noterEnvoi } = collecteur();
    const recipients = new FakeRecipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    // Un carousel non envoyable arrête le run avant la boucle : les destinataires sont marqués `failed`
    // en bloc. Le journal doit dire la MÊME chose que `campaign_recipients`, sans quoi les deux tables
    // se contrediraient précisément le jour où l'on cherche pourquoi une campagne n'a rien envoyé.
    await runCampaign(campaign, deps({
      recipients, noterEnvoi,
      getTemplateCarousel: async () => ({ cards: [] }),
    }));
    expect(vues.map((t) => [t.recipientId, t.statut])).toEqual([['r1', 'failed'], ['r2', 'failed']]);
  });

  it('une campagne RCS journalise sur SON canal', async () => {
    const { vues, noterEnvoi } = collecteur();
    const rcs: Campaign = { ...campaign, channel: 'rcs' };
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    await runCampaign(rcs, deps({
      recipients, noterEnvoi,
      channelSender: { sendTo: async () => ({ messageId: 'rcs-r1' }) },
    }));
    expect(vues[0]).toMatchObject({ canal: 'rcs', statut: 'sent', messageId: 'rcs-r1' });
  });

  it('un journal qui throw ne relabellise JAMAIS un message livré', async () => {
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const report = await runCampaign(campaign, deps({
      recipients,
      noterEnvoi: async () => { throw new Error('base down'); },
    }));
    // Best-effort, comme le journal du fil et la note de joignabilité : le pire coût est une ligne de
    // statistique manquante, jamais un run interrompu ni un envoi réussi requalifié en échec.
    expect(report).toMatchObject({ sent: 1, failed: 0 });
    expect(recipients.results.get('r1')).toMatchObject({ status: 'sent' });
  });

  it('sans câblage, le moteur n écrit rien : comportement d avant, intact', async () => {
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const report = await runCampaign(campaign, deps({ recipients }));
    expect(report).toMatchObject({ sent: 1 });
  });
});

/**
 * L'ÉTAGE QUE LE MOTEUR SERT, ET CELUI QU'IL REFUSE (dette du lot 3, soldée le 2026-09-12).
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT : la bascule écrit `etage_courant`, le moteur ne le lisait pas. Un
 * destinataire posé au rang 2 repartait donc avec le contenu du rang 1 sur le canal du rang 1, c'est-à-dire
 * le message qui venait d'échouer. Aucun test ne pouvait le voir : `listPending` ne rendait même pas la
 * colonne, donc le moteur n'avait pas de quoi se tromper, il avait de quoi ne rien savoir.
 *
 * ⚠️ ET CE QU'ILS NE PROTÈGENT PAS, pour qu'on ne le croie pas acquis : le moteur ne sait toujours pas
 * ENVOYER un second étage. Il refuse, avec sa raison. Le jour où un run saura servir un autre canal que
 * celui de sa campagne, c'est le refus qui devra tomber, et ces tests le diront en échouant.
 */
describe('runCampaign : l etage du destinataire', () => {
  const collecteurEtage = (): { vues: TentativeEnvoi[]; noterEnvoi: EngineDeps['noterEnvoi'] } => {
    const vues: TentativeEnvoi[] = [];
    return { vues, noterEnvoi: async (t) => { vues.push(t); } };
  };
  const CHAINE: Etage[] = [
    { rang: 1, canal: 'whatsapp', templateName: 'promo', templateLanguage: 'fr' },
    { rang: 2, canal: 'rcs' },
  ];

  it('sans chaine, rien ne change : le rang 1 et le canal de la campagne', async () => {
    const { vues, noterEnvoi } = collecteurEtage();
    const sender = new FakeSender();
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const report = await runCampaign(campaign, deps({ recipients, sender, noterEnvoi }));
    expect(report).toMatchObject({ sent: 1, failed: 0 });
    expect(sender.calls).toEqual(['+33611']);
    expect(vues[0]).toMatchObject({ rang: 1, canal: 'whatsapp', statut: 'sent' });
  });

  it('une chaine a UN seul etage envoie exactement comme avant', async () => {
    const sender = new FakeSender();
    const seul: Campaign = { ...campaign, chaine: [CHAINE[0]!] };
    const recipients = new FakeRecipients([{ ...rec('r1', '+33611'), etageCourant: 1 }]);
    const report = await runCampaign(seul, deps({ recipients, sender }));
    expect(report).toMatchObject({ sent: 1, failed: 0 });
    expect(sender.calls).toEqual(['+33611']);
  });

  it('🔴 un destinataire BASCULE au rang 2 n est PAS renvoye sur le canal du rang 1', async () => {
    const { vues, noterEnvoi } = collecteurEtage();
    const sender = new FakeSender();
    const avecRepli: Campaign = { ...campaign, chaine: CHAINE };
    const recipients = new FakeRecipients([{ ...rec('r1', '+33611'), etageCourant: 2 }]);
    const report = await runCampaign(avecRepli, deps({ recipients, sender, noterEnvoi }));

    // 🔴 LE CŒUR DE LA DETTE : aucun appel au sender. C'est ce qui distingue la bonne implémentation de
    // celle qui lit le rang pour le journaliser et envoie quand même.
    expect(sender.calls).toEqual([]);
    expect(report).toMatchObject({ sent: 0, failed: 1 });
    // Le refus est LISIBLE, pas un silence : c'est ce que verra le premier qui essaiera une chaîne.
    expect(recipients.results.get('r1')).toMatchObject({ status: 'failed' });
    expect(recipients.results.get('r1')!.error).toContain('étage 2');
    // Et la ligne de journal porte le VRAI rang et le VRAI canal : au rang 1 / whatsapp, l'analytique par
    // canal mettrait cet échec au crédit d'un canal qui n'a rien tenté.
    expect(vues[0]).toMatchObject({ rang: 2, canal: 'rcs', statut: 'failed' });
  });

  it('la presence d un repli ne bloque PAS le rang 1', async () => {
    const sender = new FakeSender();
    const avecRepli: Campaign = { ...campaign, chaine: CHAINE };
    const recipients = new FakeRecipients([{ ...rec('r1', '+33611'), etageCourant: 1 }]);
    const report = await runCampaign(avecRepli, deps({ recipients, sender }));
    expect(report).toMatchObject({ sent: 1, failed: 0 });
    expect(sender.calls).toEqual(['+33611']);
  });

  it('un faux sans etageCourant vaut le rang 1, jamais un refus', async () => {
    const sender = new FakeSender();
    const avecRepli: Campaign = { ...campaign, chaine: CHAINE };
    // `rec()` ne pose pas `etageCourant` : c'est le câblage de tous les tests d'avant ce lot, et le
    // traiter comme un rang inconnu les aurait tous rendus rouges.
    const recipients = new FakeRecipients([rec('r1', '+33611')]);
    const report = await runCampaign(avecRepli, deps({ recipients, sender }));
    expect(report).toMatchObject({ sent: 1, failed: 0 });
  });

  it('🔴 un etage RETIRE de la chaine refuse, il ne retombe pas sur le contenu de la campagne', async () => {
    const { vues, noterEnvoi } = collecteurEtage();
    const sender = new FakeSender();
    // La chaîne ne porte plus que le rang 1, le destinataire est resté au rang 2.
    const ampute: Campaign = { ...campaign, chaine: [CHAINE[0]!] };
    const recipients = new FakeRecipients([{ ...rec('r1', '+33611'), etageCourant: 2 }]);
    const report = await runCampaign(ampute, deps({ recipients, sender, noterEnvoi }));
    expect(sender.calls).toEqual([]);
    expect(report).toMatchObject({ sent: 0, failed: 1 });
    expect(recipients.results.get('r1')!.error).toContain('absent de la chaîne');
    expect(vues[0]).toMatchObject({ rang: 2, statut: 'failed' });
  });
});

/**
 * `etageServable` seule. Elle décide d'un envoi sur le chemin le plus chaud du produit : l'éprouver à
 * travers un run entier ne dirait pas ce qu'elle répond, seulement ce qui en sort.
 */
describe('etageServable', () => {
  it('chaine absente -> rang 1, canal de la campagne, aucun refus', () => {
    expect(etageServable({}, undefined)).toEqual({ rang: 1, canal: 'whatsapp', refus: null });
    expect(etageServable({ channel: 'rcs' }, undefined)).toEqual({ rang: 1, canal: 'rcs', refus: null });
  });

  it('chaine vide -> le comportement d avant, meme si le destinataire porte un rang 2', () => {
    // ⚠️ Une campagne d'avant 0134 non reprise n'a pas d'étage : lui refuser l'envoi arrêterait un parc
    // entier pour une colonne qu'on vient d'ajouter.
    expect(etageServable({ chaine: [] }, 2)).toEqual({ rang: 1, canal: 'whatsapp', refus: null });
  });

  it('🔴 une chaine DESORDONNEE ne change pas la reponse : c est le rang qui compte, pas la position', () => {
    const desordre: Etage[] = [{ rang: 2, canal: 'rcs' }, { rang: 1, canal: 'whatsapp' }];
    // Une implémentation qui lirait `chaine[0]` rendrait ici l'étage RCS pour un destinataire au rang 1,
    // donc refuserait un envoi parfaitement servable. La lecture SQL ne garantit aucun ordre.
    expect(etageServable({ chaine: desordre }, 1)).toEqual({ rang: 1, canal: 'whatsapp', refus: null });
  });

  it('🔴 une chaine TROUEE (rangs 1 et 3) refuse le rang 3 sans se tromper de canal', () => {
    const trouee: Etage[] = [{ rang: 1, canal: 'whatsapp' }, { rang: 3, canal: 'email' }];
    const v = etageServable({ chaine: trouee }, 3);
    // Le canal rendu est celui de l'ÉTAGE (email), pas celui de la campagne : c'est lui que le journal
    // écrira, et une implémentation qui recopierait `campaign.channel` le dirait « whatsapp ».
    expect(v).toMatchObject({ rang: 3, canal: 'email' });
    expect(v.refus).toContain('email');
    // Et le rang ABSENT de la chaîne est un refus distinct, pas un repli sur le rang 1.
    expect(etageServable({ chaine: trouee }, 2)).toMatchObject({ rang: 2, refus: expect.stringContaining('absent') });
  });
});
