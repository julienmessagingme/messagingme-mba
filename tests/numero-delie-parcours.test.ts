import { describe, it, expect } from 'vitest';
import { jamaisDesabonne } from './consentement';
import { WorkflowExecutor, envoieParWhatsApp } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';
import type { WorkflowRunRow, RunState } from '../src/workflow/run-store.pg';
import type { WalkStep } from '../src/workflow/engine';
import { NumeroDelieError } from '../src/meta/numero-delie';
import { runCampaign } from '../src/campaign/engine';
import type { RecipientStore, CampaignStore, EngineDeps } from '../src/campaign/engine';
import type { Campaign, Recipient } from '../src/campaign/types';
import { runAutomations, type AutomationRunnerDeps } from '../src/automation/runner';
import { runDateSweep } from '../src/automation/date-sweep';
import type { AutomationRow, AutomationEvent } from '../src/automation/match';

/**
 * LE NUMÉRO DÉLIÉ ET CE QUE LE PARCOURS FAIT AVANT L'ENVOI REFUSÉ (relecture du 2026-09-25), avec le VRAI
 * `WorkflowExecutor`.
 *
 * 🔴 CE QU'AUCUN TEST NE VOYAIT : ceux de `tests/numero-delie.test.ts` simulent le démarrage d'un scénario par un
 * faux qui lève tout de suite, donc sans rien faire avant. Or un scénario « e-mail, puis modèle » envoyait
 * l'e-mail, butait sur le modèle, et chaque reprise le renvoyait : la campagne rend le destinataire à la file et
 * le parcours repart de zéro au « Relier » ; une automation efface son tir, et le prochain événement le rejoue.
 *
 * Le monde de ces tests a UNE garde, lue par les deux portes qui la consultent en production : la vérification
 * préalable de `runFrom` (`verifierNumeroWhatsApp`) et l'envoi du modèle (le point de passage des envois).
 */

const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const EMAIL = { emailAccountId: 'a1', templateId: 't1', to: { kind: 'literal', value: 'client@exemple.fr' } };

/** Le scénario du défaut : un e-mail, puis un modèle WhatsApp. */
const EMAIL_PUIS_MODELE: WorkflowGraph = {
  nodes: [n('em', 'email', EMAIL), n('tpl', 'template', { templateName: 'rappel' })],
  edges: [{ id: 'e1', source: 'em', target: 'tpl' }],
};
/** Un scénario SANS WhatsApp : il doit continuer de tourner sur un numéro délié. */
const EMAIL_SEUL: WorkflowGraph = {
  nodes: [n('em', 'email', EMAIL), n('tg', 'tag', { tag: 'relance' })],
  edges: [{ id: 'e1', source: 'em', target: 'tg' }],
};

class FakeRuns {
  readonly demarres: string[] = [];
  async closeActiveByWaId(): Promise<string[]> { return []; }
  async start(_t: string, _wf: string, waId: string, _c: string | null, _s: RunState): Promise<{ id: string }> {
    this.demarres.push(waId);
    return { id: `run-${this.demarres.length}` };
  }
  async findWaitingByWaId(): Promise<WorkflowRunRow | null> { return null; }
  async setState(): Promise<void> {}
}

/**
 * Le monde : UNE garde (`delie.vrai`), les effets dans l'ordre où ils partent. `avecVerification: false` retire la
 * vérification préalable, c'est-à-dire le câblage d'avant ce correctif.
 */
function monde(graph: WorkflowGraph, o: { avecVerification?: boolean } = {}) {
  const delie = { vrai: true };
  const effets: string[] = [];
  const garde = (): void => { if (delie.vrai) throw new NumeroDelieError('pn1'); };
  const runs = new FakeRuns();
  const deps: WorkflowExecutorDeps = {
    estDesabonne: jamaisDesabonne,
    runs,
    getGraph: async () => graph,
    applyTag: async (_t, waId, tag) => { effets.push(`tag ${tag} ${waId}`); },
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async (_t, waId, nom) => { garde(); effets.push(`modèle ${nom} ${waId}`); },
    sendQuickMessage: async (_t, waId) => { garde(); effets.push(`message ${waId}`); },
    sendFlow: async (_t, waId) => { garde(); effets.push(`formulaire ${waId}`); },
    sendQuestion: async (_t, waId) => { garde(); effets.push(`question ${waId}`); },
    sendEmail: async (_t, waId) => { effets.push(`e-mail ${waId}`); },
    ...(o.avecVerification === false ? {} : { verifierNumeroWhatsApp: async () => { garde(); } }),
  };
  return { executor: new WorkflowExecutor(deps), delie, effets, runs };
}

const emails = (effets: readonly string[]) => effets.filter((e) => e.startsWith('e-mail'));

describe('envoieParWhatsApp (la question que runFrom pose avant tout effet)', () => {
  const pas = (...kinds: string[]): WalkStep[] => kinds.map((kind, i) => ({ nodeId: `n${i}`, action: { kind } as WalkStep['action'] }));

  it('un modèle, un formulaire, une question : oui, quel que soit le canal du parcours', () => {
    for (const k of ['sendTemplate', 'sendFlow', 'sendQuestion']) {
      expect(envoieParWhatsApp(pas('sendEmail', k), 'whatsapp'), k).toBe(true);
      expect(envoieParWhatsApp(pas('sendEmail', k), 'rcs'), k).toBe(true);
    }
  });

  it('un message rapide suit le canal du parcours, comme dans `apply`', () => {
    expect(envoieParWhatsApp(pas('sendQuickMessage'), 'whatsapp')).toBe(true);
    expect(envoieParWhatsApp(pas('sendQuickMessage'), 'rcs')).toBe(false);
  });

  it('🔴 un e-mail seul, des actions seules : non, le scénario continue de tourner sur un numéro délié', () => {
    expect(envoieParWhatsApp(pas('sendEmail', 'tag', 'field', 'appelHttp'), 'whatsapp')).toBe(false);
    expect(envoieParWhatsApp([], 'whatsapp')).toBe(false);
  });
});

describe('le vrai exécuteur sur un numéro délié', () => {
  it('🔴 « e-mail, puis modèle » : refusé AVANT l’e-mail, aucun parcours persisté, et l’exception remonte telle quelle', async () => {
    const m = monde(EMAIL_PUIS_MODELE);
    await expect(m.executor.start('t1', 'wf1', EMAIL_PUIS_MODELE, { waId: '33611', contactId: 'c1' })).rejects.toBeInstanceOf(NumeroDelieError);
    expect(m.effets, 'l’e-mail est parti avant l’envoi refusé').toEqual([]);
    expect(m.runs.demarres).toEqual([]);
    // Relié : le même démarrage fait tout, dans l'ordre.
    m.delie.vrai = false;
    expect(await m.executor.start('t1', 'wf1', EMAIL_PUIS_MODELE, { waId: '33611', contactId: 'c1' })).toBe(true);
    expect(m.effets).toEqual(['e-mail 33611', 'modèle rappel 33611']);
  });

  it('🔴 un scénario SANS WhatsApp continue de tourner sur un numéro délié', async () => {
    const m = monde(EMAIL_SEUL);
    expect(await m.executor.start('t1', 'wf1', EMAIL_SEUL, { waId: '33611', contactId: 'c1' })).toBe(true);
    expect(m.effets).toEqual(['e-mail 33611', 'tag relance 33611']);
  });
});

// --------------------------------------------------------------------------------------------------------
// Côté campagne : le destinataire rendu à la file ne reçoit pas l'e-mail deux fois
// --------------------------------------------------------------------------------------------------------

/** Des destinataires qui ont un ÉTAT : ce que le run réserve, rend à la file ou résout. */
class Destinataires implements RecipientStore {
  readonly etats = new Map<string, Recipient['status']>();
  constructor(private readonly tous: Recipient[]) { for (const r of tous) this.etats.set(r.id, 'pending'); }
  async listPending(): Promise<Recipient[]> {
    return this.tous.filter((r) => this.etats.get(r.id) === 'pending').map((r) => ({ ...r, status: 'pending' }));
  }
  async claim(id: string): Promise<boolean> {
    if (this.etats.get(id) !== 'pending') return false;
    this.etats.set(id, 'sending');
    return true;
  }
  async relacher(id: string): Promise<void> { this.etats.set(id, 'pending'); }
  async markResult(id: string, r: { status: 'sent' | 'failed' | 'skipped' }): Promise<void> { this.etats.set(id, r.status); }
}
class Campagnes implements CampaignStore {
  readonly statuts: string[] = [];
  async setStatus(_id: string, status: Campaign['status']): Promise<void> { this.statuts.push(status); }
}

const CAMPAGNE: Campaign = {
  id: 'c1', tenantId: 't1', phoneNumberId: 'pn1', category: 'utility', templateName: '', templateLanguage: 'fr',
  paramMapping: [], status: 'running', workflowId: 'wf1', ratePerMinute: null, startNodeId: null,
};
const DEUX: Recipient[] = [
  { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
  { id: 'r2', contactId: 'y', toE164: '+33622', resolvedParams: [], status: 'pending' },
];

describe('campagne de scénario, numéro délié puis relié, avec le vrai exécuteur', () => {
  function monter(o: { avecVerification?: boolean } = {}) {
    const m = monde(EMAIL_PUIS_MODELE, o);
    const destinataires = new Destinataires(DEUX);
    const campagnes = new Campagnes();
    const pauses: string[] = [];
    const deps: EngineDeps = {
      sender: {
        sendMarketing: async () => { throw new Error('aucun modèle direct ici'); },
        sendTemplate: async () => { throw new Error('aucun modèle direct ici'); },
      },
      recipients: destinataires, campaigns: campagnes,
      frequency: { lastSentAt: async () => null, record: async () => {} },
      quality: { getRating: async () => 'GREEN' },
      // Le câblage du worker : un démarrage de campagne reprend le fil (`ignoreHumanControl`).
      startWorkflow: (tenant, wf, waId, contactId, params) =>
        m.executor.start(tenant, wf, EMAIL_PUIS_MODELE, { waId, contactId }, params, { ignoreHumanControl: true }),
      pauserSiNumeroDelie: async (id) => { pauses.push(id); return m.delie.vrai; },
    };
    return { m, destinataires, campagnes, pauses, run: () => runCampaign(CAMPAGNE, deps) };
  }

  it('🔴 délié : le destinataire est rendu à la file SANS avoir reçu l’e-mail ; relié : chacun reçoit UN e-mail et son modèle', async () => {
    const c = monter();
    const avant = await c.run();
    expect(avant).toMatchObject({ sent: 0, failed: 0, paused: true });
    expect(c.pauses).toEqual(['c1']);
    expect(c.destinataires.etats.get('r1')).toBe('pending');
    expect(c.m.effets).toEqual([]);

    // « Relier » : le balayage relance la campagne, qui reprend les deux destinataires.
    c.m.delie.vrai = false;
    const apres = await c.run();
    expect(apres).toMatchObject({ sent: 2, failed: 0, paused: false });
    expect(emails(c.m.effets), 'le destinataire rendu à la file a reçu l’e-mail deux fois').toEqual(['e-mail 33611', 'e-mail 33622']);
    expect(c.m.effets).toEqual(['e-mail 33611', 'modèle rappel 33611', 'e-mail 33622', 'modèle rappel 33622']);
    // Chaque run pose `running` en entrant ; le second sort `completed`, et aucune pause n'a été écrite en direct.
    expect(c.campagnes.statuts).toEqual(['running', 'running', 'completed']);
  });
});

// --------------------------------------------------------------------------------------------------------
// Côté automation : le rappel `avant_date` et un déclencheur ordinaire
// --------------------------------------------------------------------------------------------------------

const T = Date.parse('2026-08-23T10:00:00Z'); // 12 h à Paris
const auto = (over: Partial<AutomationRow>): AutomationRow => ({
  id: 'a1', tenantId: 't1', name: 'A', enabled: true, triggerKind: 'tag_added', triggerConfig: { tag: 'vip' },
  conditionGroup: null, workflowId: 'wf1', startNodeId: null, cooldownSeconds: null, maxFiresPerHour: null, possedePar: null, ...over,
});

/** Les tirs, par (automation, contact), avec leur marqueur d'occurrence : la même règle que le dépôt. */
function tirs() {
  const t = new Map<string, string | null>();
  const cle = (id: string, waId: string) => `${id}|${waId}`;
  return {
    t,
    lastFiredAt: async (id: string, waId: string) => (t.has(cle(id, waId)) ? new Date(T - 120_000) : null),
    markFired: async (id: string, waId: string, marqueur?: string) => {
      if (marqueur !== undefined && t.get(cle(id, waId)) === marqueur) return false;
      t.set(cle(id, waId), marqueur ?? null);
      return true;
    },
    clearFired: async (id: string, waId: string) => { t.delete(cle(id, waId)); },
  };
}

function runner(rows: AutomationRow[], m: ReturnType<typeof monde>, registre: ReturnType<typeof tirs>): AutomationRunnerDeps {
  return {
    listEnabled: async () => rows,
    lastFiredAt: registre.lastFiredAt,
    markFired: registre.markFired,
    clearFired: registre.clearFired,
    evalContext: async () => null,
    // Le câblage du worker : un démarrage hors fenêtre passe par `start`.
    startWorkflow: (tenant, wf, waId) => m.executor.start(tenant, wf, EMAIL_PUIS_MODELE, { waId, contactId: null }, undefined, { emitEvents: true }),
    // Un anti-rebond COURT : c'est le cas où l'effacement du tir rend la main au prochain événement.
    defaultCooldownSeconds: 60,
    now: () => T,
  };
}

describe('automation sur un numéro délié, avec le vrai exécuteur', () => {
  it('🔴 déclencheur ordinaire (tag posé) : aucun e-mail tant que le numéro est délié, UN seul au premier événement après « Relier »', async () => {
    const m = monde(EMAIL_PUIS_MODELE);
    const registre = tirs();
    const deps = runner([auto({})], m, registre);
    const ev: AutomationEvent = { kind: 'tag_added', waId: '33611', tag: 'vip' };

    expect(await runAutomations('t1', ev, deps)).toBe(0);
    // Le tir est effacé (rien n'est parti), donc le prochain événement redéclenche.
    expect(registre.t.size).toBe(0);
    expect(await runAutomations('t1', ev, deps)).toBe(0);
    expect(m.effets).toEqual([]);

    m.delie.vrai = false;
    expect(await runAutomations('t1', ev, deps)).toBe(1);
    expect(emails(m.effets), 'chaque événement refusé avait déjà envoyé l’e-mail').toEqual(['e-mail 33611']);
  });

  it('🔴 rappel `avant_date` : le balayage ne le republie pas, et aucun e-mail ne part', async () => {
    const m = monde(EMAIL_PUIS_MODELE);
    const registre = tirs();
    const rappel = auto({ triggerKind: 'avant_date', triggerConfig: { fieldKey: 'rdv', delai: 2, unite: 'heures' } });
    const deps = runner([rappel], m, registre);
    // Le balayage PUBLIE, l'événement repasse par `runAutomations` : la chaîne de production, sans la file.
    const balayer = () => runDateSweep({
      tenants: async () => ['t1'],
      automations: async () => [rappel],
      timeZone: async () => 'Europe/Paris',
      candidats: async () => [{ waId: '33611', valeur: '2026-08-23T14:00', dejaTirePour: registre.t.get('a1|33611') ?? null }],
      publish: async (tenant, ev) => { await runAutomations(tenant, ev, deps); },
      toleranceMinutes: 60,
      now: () => T,
    });

    expect(await balayer()).toBe(1);
    // Le tir est GARDÉ pour un rappel (`runner.ts`) : le balayage suivant ne republie rien.
    expect(registre.t.get('a1|33611')).toBe('2026-08-23T14:00');
    expect(await balayer()).toBe(0);
    expect(m.effets).toEqual([]);
  });
});
