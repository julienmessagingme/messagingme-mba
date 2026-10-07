import { describe, it, expect, vi } from 'vitest';
import { runAutomations } from '../src/automation/runner';
import type { AutomationRunnerDeps } from '../src/automation/runner';
import { POSSESSEUR_LIEN_CHAINE, POSSESSEUR_PUBLICITE, POSSESSEUR_WIDGET, type AutomationRow, type AutomationEvent } from '../src/automation/match';
import { DROITS, type Offre } from '../src/offres/offres';

/**
 * 🔴 LE GEL DES AUTOMATIONS AU RETOUR EN BASE (lot 6, livraison B2a, spec § 7, décision de Julien du 2026-10-07). Sous une
 * limite d'automations, seules les plus anciennes du client (allumées, sans propriétaire) tirent encore ; celles d'une
 * chaîne ou d'une publicité se taisent quand l'offre n'ouvre plus leur fonction ; celles d'un widget continuent. Rien
 * n'est éteint en base : tout revient au réabonnement.
 */
const T = new Date('2026-10-07T12:00:00Z').getTime();
const MSG: AutomationEvent = { kind: 'message', waId: '33611', body: 'rdv', isNewContact: false, channel: 'whatsapp' };

const auto = (id: string, over: Partial<AutomationRow> = {}): AutomationRow => ({
  id, tenantId: 't1', name: id, enabled: true,
  triggerKind: 'keyword', triggerConfig: { keywords: ['rdv'] }, conditionGroup: null,
  workflowId: `wf-${id}`, startNodeId: null, cooldownSeconds: null, maxFiresPerHour: null, possedePar: null, ...over,
});

function monter(rows: AutomationRow[], offre: Offre, anciennes: string[]) {
  const demarrees: string[] = [];
  const marquees: string[] = [];
  const lectures: Array<{ tenantId: string; n: number }> = [];
  const deps: AutomationRunnerDeps = {
    automations: {
      listEnabled: async () => rows,
      lastFiredAt: async () => null,
      markFired: async (id) => { marquees.push(id); return true; },
      clearFired: async () => {},
      plusAnciennes: async (tenantId, n) => { lectures.push({ tenantId, n }); return new Set(anciennes.slice(0, n)); },
    },
    offres: { offreDe: async () => ({ offre, droits: DROITS[offre], retourEnBaseLe: null }) },
    evalContext: async () => null,
    startWorkflow: async (d) => { demarrees.push(d.workflowId); return true; },
    defaultCooldownSeconds: 0,
    now: () => T,
  };
  return { deps, demarrees, marquees, lectures };
}

describe('le gel des automations (lot 6, B2a)', () => {
  it('🔴 en Base, seules les 10 plus anciennes du client tirent : la 11e et la 12e ne tirent pas, et rien ne les marque', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ids = Array.from({ length: 12 }, (_, i) => `c${String(i + 1).padStart(2, '0')}`);
    const m = monter(ids.map((id) => auto(id)), 'base', ids);
    expect(await runAutomations('t1', MSG, m.deps)).toBe(10);
    expect(m.demarrees).toEqual(ids.slice(0, 10).map((id) => `wf-${id}`));
    expect(m.marquees).not.toContain('c11');
    expect(m.lectures).toEqual([{ tenantId: 't1', n: DROITS.base.limites.automations }]);
  });

  it('🔴 en Base, la chaîne, la publicité et le widget à scénario se taisent (décision de Julien : le widget suit les scénarios)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const rows = [
      auto('chaine', { possedePar: POSSESSEUR_LIEN_CHAINE }),
      auto('pub', { possedePar: POSSESSEUR_PUBLICITE }),
      auto('widget', { possedePar: POSSESSEUR_WIDGET }),
    ];
    const m = monter(rows, 'base', []);
    expect(await runAutomations('t1', MSG, m.deps)).toBe(0);
    expect(m.demarrees).toEqual([]);
    expect(m.marquees).toEqual([]);
    // Aucune automation du client parmi les candidates : la liste des plus anciennes n'est pas lue.
    expect(m.lectures).toEqual([]);
  });

  it('en Pro, le widget à scénario tire, sans compter dans les automations du client', async () => {
    const m = monter([auto('widget', { possedePar: POSSESSEUR_WIDGET })], 'pro', []);
    expect(await runAutomations('t1', MSG, m.deps)).toBe(1);
    expect(m.demarrees).toEqual(['wf-widget']);
  });

  it('en Pro, rien n’est gelé, et la liste des plus anciennes n’est jamais lue', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const rows = [...ids.map((id) => auto(id)), auto('chaine', { possedePar: POSSESSEUR_LIEN_CHAINE })];
    const m = monter(rows, 'pro', []);
    expect(await runAutomations('t1', MSG, m.deps)).toBe(13);
    expect(m.lectures).toEqual([]);
  });

  it('en Base, une automation du client qui n’est pas parmi les plus anciennes ne tire pas, même seule candidate', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = monter([auto('recente')], 'base', ['a1', 'a2']);
    expect(await runAutomations('t1', MSG, m.deps)).toBe(0);
    expect(m.marquees).toEqual([]);
  });
});
