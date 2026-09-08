import { describe, it, expect } from 'vitest';
import { matchesTrigger, isAutomationTriggerKind } from '../src/automation/match';
import type { AutomationRow, AutomationEvent } from '../src/automation/match';
import { parseAutomationEventJob } from '../src/automation/event-job';
import { runAutomations } from '../src/automation/runner';
import type { AutomationRunnerDeps } from '../src/automation/runner';

/**
 * Le déclencheur `webhook` : un outil tiers a posté sur l'URL d'un webhook entrant.
 *
 * Ce que ces tests protègent, et qui n'est écrit nulle part ailleurs :
 *  1. L'identifiant du webhook DISCRIMINE. Sans lui, l'appel d'un webhook lancerait les scénarios de tous les
 *     autres webhooks de l'espace.
 *  2. La fenêtre de service 24 h n'est PAS prouvée. Un webhook n'est pas un message du contact : le scénario
 *     doit ouvrir par un template approuvé, sinon la garde de l'exécuteur le refuse. C'est la décision de
 *     Julien du 2026-08-22, et rien d'autre ne la vérifie.
 */

const T = new Date('2026-08-23T12:00:00Z').getTime();

const auto = (over: Partial<AutomationRow> = {}): AutomationRow => ({
  id: 'a1', tenantId: 't1', name: 'Webhook : commandes', enabled: true,
  triggerKind: 'webhook', triggerConfig: { webhookId: 'wh1' }, conditionGroup: null,
  workflowId: 'wf1', startNodeId: null, cooldownSeconds: null, maxFiresPerHour: null, possedePar: null, ...over,
});
const EV: AutomationEvent = { kind: 'webhook', waId: '33611', webhookId: 'wh1' };

describe('déclencheur webhook : correspondance', () => {
  it('`webhook` est un type de déclencheur reconnu', () => {
    expect(isAutomationTriggerKind('webhook')).toBe(true);
  });

  it('correspond quand l’identifiant du webhook est le bon', () => {
    expect(matchesTrigger(auto(), EV)).toBe(true);
  });

  it('🔴 ne correspond PAS à l’appel d’un AUTRE webhook', () => {
    // Sans cette garde, poser une URL de test dans un outil déclencherait les scénarios de tous les webhooks.
    expect(matchesTrigger(auto(), { kind: 'webhook', waId: '33611', webhookId: 'wh2' })).toBe(false);
  });

  it('🔴 une automation SANS webhook configuré n’attrape rien', () => {
    // Même doctrine que le tag vide : une automation inerte plutôt qu'une automation qui part sur tout.
    expect(matchesTrigger(auto({ triggerConfig: {} }), EV)).toBe(false);
    expect(matchesTrigger(auto({ triggerConfig: { webhookId: '  ' } }), EV)).toBe(false);
  });

  it('ne correspond à aucun autre type d’événement', () => {
    expect(matchesTrigger(auto(), { kind: 'message', waId: '33611', body: 'wh1', isNewContact: false, channel: 'whatsapp' })).toBe(false);
    expect(matchesTrigger(auto(), { kind: 'tag_added', waId: '33611', tag: 'wh1' })).toBe(false);
  });

  it('un autre type d’automation ne réagit pas à un événement webhook', () => {
    expect(matchesTrigger(auto({ triggerKind: 'new_contact', triggerConfig: {} }), EV)).toBe(false);
  });
});

describe('déclencheur webhook : la file', () => {
  it('accepte un événement bien formé', () => {
    expect(parseAutomationEventJob({ tenantId: 't1', event: { kind: 'webhook', waId: '33611', webhookId: 'wh1' } }))
      .toEqual({ tenantId: 't1', event: { kind: 'webhook', waId: '33611', webhookId: 'wh1' } });
  });

  it('🔴 refuse un événement SANS identifiant de webhook', () => {
    // Un événement anonyme risquerait de déclencher les automations d'un autre webhook.
    for (const mauvais of [{}, { webhookId: '' }, { webhookId: '   ' }, { webhookId: 42 }]) {
      expect(parseAutomationEventJob({ tenantId: 't1', event: { kind: 'webhook', waId: '33611', ...mauvais } })).toBeNull();
    }
  });

  it('refuse un événement sans contact', () => {
    expect(parseAutomationEventJob({ tenantId: 't1', event: { kind: 'webhook', waId: '', webhookId: 'wh1' } })).toBeNull();
  });
});

describe('déclencheur webhook : le démarrage', () => {
  interface Trace { kinds: readonly string[][]; started: Array<{ windowOpen: boolean }> }

  function make(rows: AutomationRow[]): { deps: AutomationRunnerDeps; trace: Trace } {
    const trace: Trace = { kinds: [], started: [] };
    const deps: AutomationRunnerDeps = {
      listEnabled: async (_t, kinds) => { (trace.kinds as string[][]).push([...kinds]); return rows; },
      lastFiredAt: async () => null,
      markFired: async () => true,
      clearFired: async () => {},
      evalContext: async () => null,
      startWorkflow: async (_t, _wf, _w, o) => { trace.started.push({ windowOpen: o.windowOpen }); return true; },
      defaultCooldownSeconds: 3600,
      now: () => T,
    };
    return { deps, trace };
  }

  it('ne charge QUE les automations de type webhook', async () => {
    const { deps, trace } = make([auto()]);
    await runAutomations('t1', EV, deps);
    expect(trace.kinds).toEqual([['webhook']]);
  });

  it('🔴 la fenêtre de service n’est PAS présumée ouverte', async () => {
    // Un webhook vient d'un outil, pas du contact : rien ne prouve qu'il a écrit dans les 24 h. Le scénario
    // doit donc ouvrir par un template approuvé, et c'est la garde de l'exécuteur qui l'impose. Passer `true`
    // ici enverrait un message libre hors fenêtre, que Meta refuserait.
    const { deps, trace } = make([auto()]);
    expect(await runAutomations('t1', EV, deps)).toBe(1);
    expect(trace.started).toEqual([{ windowOpen: false }]);
  });

  it('les garde-fous communs s’appliquent : un contact bloqué ne déclenche rien', async () => {
    const { deps, trace } = make([auto()]);
    expect(await runAutomations('t1', EV, { ...deps, contactBloque: async () => true })).toBe(0);
    expect(trace.started).toEqual([]);
  });

  it('les garde-fous communs s’appliquent : l’anti-rebond par contact', async () => {
    const { deps, trace } = make([auto({ cooldownSeconds: 3600 })]);
    // Tir enregistré il y a une minute : le second appel du tiers ne relance pas le scénario.
    expect(await runAutomations('t1', EV, { ...deps, lastFiredAt: async () => new Date(T - 60_000) })).toBe(0);
    expect(trace.started).toEqual([]);
  });
});
