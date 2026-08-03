import { describe, it, expect } from 'vitest';
import { runAutomations } from '../src/automation/runner';
import type { AutomationRunnerDeps } from '../src/automation/runner';
import type { AutomationRow, AutomationEvent } from '../src/automation/match';
import type { EvalContext } from '../src/workflow/conditions';

/**
 * Orchestration d'un déclenchement (IO injectée).
 *
 * Ce que ces tests protègent :
 *  1. Les trois filtres sont bien composés : déclencheur, puis anti-rebond, puis condition. Sauter l'un d'eux
 *     envoie un message à un client qui ne devait pas le recevoir.
 *  2. Le marquage anti-rebond a lieu AVANT le démarrage. Sinon un scénario qui échoue à mi-chemin se
 *     re-déclenche en boucle sur le message suivant.
 *  3. Une automation qui plante n'empêche pas les autres (le job webhook est partagé).
 *  4. Le contexte contact n'est chargé QUE si une condition l'exige, et une seule fois.
 */

const T = new Date('2026-08-03T12:00:00Z').getTime();

const auto = (over: Partial<AutomationRow> = {}): AutomationRow => ({
  id: 'a1', tenantId: 't1', name: 'A', enabled: true,
  triggerKind: 'keyword', triggerConfig: { keywords: ['rdv'] }, conditionGroup: null,
  workflowId: 'wf1', startNodeId: null, cooldownSeconds: null, ...over,
});
const ctx = (over: Partial<EvalContext> = {}): EvalContext => ({
  fields: {}, tags: [], optIn: 'unknown', name: null, phone: null, bsuid: null,
  now: new Date(T), timeZone: 'Europe/Paris', businessHours: {}, ...over,
});
const MSG: AutomationEvent = { kind: 'message', waId: '33611', body: 'je veux un rdv', isNewContact: false };

interface Trace {
  started: Array<{ workflowId: string; startNodeId: string | null; windowOpen: boolean }>;
  fired: string[]; cleared: string[]; ctxCalls: number;
}

function make(rows: AutomationRow[], over: Partial<AutomationRunnerDeps> = {}): { deps: AutomationRunnerDeps; trace: Trace } {
  const trace: Trace = { started: [], fired: [], cleared: [], ctxCalls: 0 };
  const deps: AutomationRunnerDeps = {
    listEnabled: async () => rows,
    lastFiredAt: async () => null,
    markFired: async (id) => { trace.fired.push(id); },
    clearFired: async (id) => { trace.cleared.push(id); },
    hasWaitingRun: async () => false,
    evalContext: async () => { trace.ctxCalls += 1; return ctx(); },
    startWorkflow: async (_t, workflowId, _w, startNodeId, windowOpen) => { trace.started.push({ workflowId, startNodeId, windowOpen }); return true; },
    defaultCooldownSeconds: 3600,
    now: () => T,
    ...over,
  };
  return { deps, trace };
}

describe('runAutomations', () => {
  it('déclencheur qui correspond -> démarre le scénario et enregistre le tir', async () => {
    const { deps, trace } = make([auto()]);
    expect(await runAutomations('t1', MSG, deps)).toBe(1);
    expect(trace.started).toEqual([{ workflowId: 'wf1', startNodeId: null, windowOpen: true }]);
    expect(trace.fired).toEqual(['a1']);
  });

  it('déclencheur qui ne correspond pas -> rien, et AUCUNE requête d’anti-rebond', async () => {
    let lastFiredCalls = 0;
    const { deps, trace } = make([auto({ triggerConfig: { keywords: ['facture'] } })], {
      lastFiredAt: async () => { lastFiredCalls += 1; return null; },
    });
    expect(await runAutomations('t1', MSG, deps)).toBe(0);
    expect(trace.started).toEqual([]);
    expect(lastFiredCalls).toBe(0); // le filtre pur passe AVANT toute requête
  });

  it('une automation désactivée n’est jamais déclenchée, même si le store la renvoyait', async () => {
    // Ceinture-bretelles : la requête filtre déjà `enabled`, le runner revérifie.
    const { deps, trace } = make([auto({ enabled: false })]);
    expect(await runAutomations('t1', MSG, deps)).toBe(0);
    expect(trace.started).toEqual([]);
  });

  it('contact en anti-rebond -> ne démarre pas, et ne re-marque pas le tir', async () => {
    const { deps, trace } = make([auto()], { lastFiredAt: async () => new Date(T - 60_000) });
    expect(await runAutomations('t1', MSG, deps)).toBe(0);
    expect(trace.started).toEqual([]);
    expect(trace.fired).toEqual([]);
  });

  it('démarre à un BLOC PRÉCIS quand l’automation en cible un', async () => {
    const { deps, trace } = make([auto({ startNodeId: 'n5' })]);
    await runAutomations('t1', MSG, deps);
    expect(trace.started).toEqual([{ workflowId: 'wf1', startNodeId: 'n5', windowOpen: true }]);
  });

  describe('filtre de condition', () => {
    const withTag = auto({ conditionGroup: { match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] } });

    it('condition NON satisfaite -> pas de démarrage', async () => {
      const { deps, trace } = make([withTag], { evalContext: async () => ctx({ tags: [] }) });
      expect(await runAutomations('t1', MSG, deps)).toBe(0);
      expect(trace.started).toEqual([]);
    });

    it('condition satisfaite -> démarrage', async () => {
      const { deps, trace } = make([withTag], { evalContext: async () => ctx({ tags: ['vip'] }) });
      expect(await runAutomations('t1', MSG, deps)).toBe(1);
      expect(trace.started).toHaveLength(1);
    });

    it('contact introuvable -> on NE déclenche PAS (filtre invérifiable)', async () => {
      const { deps, trace } = make([withTag], { evalContext: async () => null });
      expect(await runAutomations('t1', MSG, deps)).toBe(0);
      expect(trace.started).toEqual([]);
    });

    it('aucune condition -> le contexte contact n’est JAMAIS chargé (pas de requête inutile)', async () => {
      const { deps, trace } = make([auto(), auto({ id: 'a2' })]);
      await runAutomations('t1', MSG, deps);
      expect(trace.ctxCalls).toBe(0);
    });

    it('plusieurs automations avec condition -> contexte chargé UNE seule fois', async () => {
      let calls = 0;
      const { deps } = make([withTag, { ...withTag, id: 'a2' }], {
        evalContext: async () => { calls += 1; return ctx({ tags: ['vip'] }); },
      });
      expect(await runAutomations('t1', MSG, deps)).toBe(2);
      expect(calls).toBe(1); // 2 automations conditionnées, 1 seule requête de contexte
    });
  });

  it('le tir est marqué AVANT le démarrage : un scénario qui échoue ne reboucle pas', async () => {
    const order: string[] = [];
    const { deps } = make([auto()], {
      markFired: async () => { order.push('fired'); },
      startWorkflow: async () => { order.push('started'); throw new Error('scénario cassé'); },
    });
    expect(await runAutomations('t1', MSG, deps)).toBe(0); // l'échec n'est pas compté comme un démarrage
    expect(order).toEqual(['fired', 'started']);
  });

  it('un scénario qui ne démarre pas (false) n’est pas compté', async () => {
    const { deps } = make([auto()], { startWorkflow: async () => false });
    expect(await runAutomations('t1', MSG, deps)).toBe(0);
  });

  it('une automation qui plante n’empêche pas les suivantes', async () => {
    const started: string[] = [];
    const { deps } = make([auto({ id: 'ko' }), auto({ id: 'ok', workflowId: 'wf2' })], {
      lastFiredAt: async (id) => { if (id === 'ko') throw new Error('base indisponible'); return null; },
      startWorkflow: async (_t, wf) => { started.push(wf); return true; },
    });
    expect(await runAutomations('t1', MSG, deps)).toBe(1);
    expect(started).toEqual(['wf2']);
  });

  it('aucune automation active -> aucun travail', async () => {
    const { deps, trace } = make([]);
    expect(await runAutomations('t1', MSG, deps)).toBe(0);
    expect(trace.ctxCalls).toBe(0);
  });

  // --- Corrections issues de la revue du Lot E ---

  describe('fenêtre de service prouvée par l’événement', () => {
    it('déclenché par un MESSAGE -> fenêtre ouverte : le scénario peut ouvrir par un message rapide', async () => {
      // Le contact vient d'écrire, donc la fenêtre 24 h est ouverte : c'est TOUT l'intérêt du déclencheur
      // mot-clé (« rdv » -> message rapide « quel créneau ? »). Sans ce signal, la garde de l'exécuteur
      // refusait ce scénario et RIEN ne partait, en silence.
      const { deps, trace } = make([auto()]);
      await runAutomations('t1', MSG, deps);
      expect(trace.started[0]?.windowOpen).toBe(true);
    });

    it('déclenché par un TAG (fenêtre non prouvée) -> garde normale conservée', async () => {
      const a = auto({ triggerKind: 'tag_added', triggerConfig: { tag: 'vip' } });
      const { deps, trace } = make([a]);
      await runAutomations('t1', { kind: 'tag_added', waId: '33611', tag: 'vip' }, deps);
      expect(trace.started[0]?.windowOpen).toBe(false);
    });
  });

  describe('un seul parcours actif par contact', () => {
    it('un run est DÉJÀ en attente -> aucun démarrage, et l’anti-rebond n’est pas consommé', async () => {
      // Sinon un message qui répond à un scénario en cours ET contient le mot-clé enverrait DEUX messages,
      // et le premier run deviendrait orphelin (l'avance n'en retrouve qu'un).
      const { deps, trace } = make([auto()], { hasWaitingRun: async () => true });
      expect(await runAutomations('t1', MSG, deps)).toBe(0);
      expect(trace.started).toEqual([]);
      expect(trace.fired).toEqual([]);
    });
  });

  describe('anti-rebond libéré quand rien n’est parti', () => {
    it('scénario NON démarré (false) -> le tir est annulé (la prochaine demande du client passera)', async () => {
      // `false` = les gardes ont refusé AVANT tout envoi (fil tenu par un opérateur, scénario supprimé).
      // Garder le tir ferait taire une vraie demande pendant toute la durée de l'anti-rebond.
      const { deps, trace } = make([auto()], { startWorkflow: async () => false });
      expect(await runAutomations('t1', MSG, deps)).toBe(0);
      expect(trace.fired).toEqual(['a1']);
      expect(trace.cleared).toEqual(['a1']);
    });

    it('scénario qui LÈVE une exception -> le tir est CONSERVÉ (un envoi a pu partir)', async () => {
      const { deps, trace } = make([auto()], { startWorkflow: async () => { throw new Error('coupure réseau'); } });
      expect(await runAutomations('t1', MSG, deps)).toBe(0);
      expect(trace.fired).toEqual(['a1']);
      expect(trace.cleared).toEqual([]); // pas d'annulation : on ne sait pas si un message est parti
    });

    it('démarrage réussi -> le tir reste (c’est lui qui protège de la boucle)', async () => {
      const { deps, trace } = make([auto()]);
      await runAutomations('t1', MSG, deps);
      expect(trace.cleared).toEqual([]);
    });
  });
});
