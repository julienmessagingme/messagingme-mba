import { describe, it, expect } from 'vitest';
import { runDateSweep } from '../src/automation/date-sweep';
import type { DateSweepDeps } from '../src/automation/date-sweep';
import type { AutomationRow } from '../src/automation/match';

/**
 * Le balayage du déclencheur « X avant une date ». Il PUBLIE, il ne démarre rien : le scénario part par le
 * chemin commun, donc avec les garde-fous de `runAutomations`.
 */

const MAINTENANT = Date.parse('2026-08-23T10:00:00Z'); // 12 h à Paris

const auto = (over: Partial<AutomationRow> = {}): AutomationRow => ({
  id: 'a1', tenantId: 't1', name: 'Rappel rendez-vous', enabled: true,
  triggerKind: 'avant_date', triggerConfig: { fieldKey: 'rdv', delai: 2, unite: 'heures' },
  conditionGroup: null, workflowId: 'wf1', startNodeId: null, cooldownSeconds: null,
  maxFiresPerHour: null, possedePar: null, ...over,
});

interface Trace {
  publies: Array<{ waId: string; automationId: string; valeur: string }>;
  fenetres: Array<{ basse: string; haute: string }>;
  journal: string[];
}

function make(
  rows: AutomationRow[],
  candidats: Array<{ waId: string; valeur: string; dejaTirePour: string | null }>,
  over: Partial<DateSweepDeps> = {},
): { deps: DateSweepDeps; trace: Trace } {
  const trace: Trace = { publies: [], fenetres: [], journal: [] };
  const deps: DateSweepDeps = {
    tenants: async () => ['t1'],
    automations: async () => rows,
    timeZone: async () => 'Europe/Paris',
    candidats: async (_t, _a, _k, basse, haute) => { trace.fenetres.push({ basse, haute }); return candidats; },
    publish: async (_t, ev) => { trace.publies.push({ waId: ev.waId, automationId: ev.automationId, valeur: ev.valeur }); },
    toleranceMinutes: 60,
    now: () => MAINTENANT,
    log: (m) => trace.journal.push(m),
    ...over,
  };
  return { deps, trace };
}

describe('balayage des échéances', () => {
  it('🔴 publie pour un contact dont l’échéance vient d’arriver', async () => {
    // Rendez-vous à 14 h (heure de Paris), rappel 2 h avant : il est 12 h.
    const { deps, trace } = make([auto()], [{ waId: '33611', valeur: '2026-08-23T14:00', dejaTirePour: null }]);
    expect(await runDateSweep(deps)).toBe(1);
    expect(trace.publies).toEqual([{ waId: '33611', automationId: 'a1', valeur: '2026-08-23T14:00' }]);
  });

  it('🔴 sens « après » : la FENÊTRE cherchée bascule de l’autre côté du présent', async () => {
    /**
     * C'est le piège de ce lot, et il est muet : la fenêtre SQL est centrée sur `maintenant + délai` pour
     * « avant ». Pour « après », les dates dues sont dans le PASSÉ (`maintenant - délai`). Garder le même
     * centre ramènerait une population qui ne contient jamais les bons contacts : l'automation ne publierait
     * rien, sans erreur, sans journal, et on chercherait le défaut dans la décision par contact, qui est
     * juste. On compare donc les deux centres, qui doivent être de part et d'autre de maintenant.
     */
    const dateDue = '2026-08-23T10:00'; // 10 h Paris, soit 2 h avant maintenant (12 h Paris)
    const { deps, trace } = make(
      [auto({ triggerConfig: { fieldKey: 'rdv', delai: 2, unite: 'heures', sens: 'apres' } })],
      [{ waId: '33611', valeur: dateDue, dejaTirePour: null }],
    );
    expect(await runDateSweep(deps)).toBe(1);
    expect(trace.publies).toEqual([{ waId: '33611', automationId: 'a1', valeur: dateDue }]);

    // Preuve inverse sur la FENÊTRE elle-même : son centre est AVANT maintenant pour « après », APRÈS pour
    // « avant ». Sans cette assertion, un centre resté du mauvais côté passerait tant que la marge de 24 h
    // du SQL le rattrape, et casserait au premier délai supérieur à un jour.
    const centreApres = new Date(trace.fenetres[0]!.basse).getTime() + 24 * 3600_000;
    expect(centreApres).toBeLessThan(MAINTENANT);

    const { deps: d2, trace: t2 } = make([auto()], []);
    await runDateSweep(d2);
    const centreAvant = new Date(t2.fenetres[0]!.basse).getTime() + 24 * 3600_000;
    expect(centreAvant).toBeGreaterThan(MAINTENANT);
  });

  it('🔴 ne publie PAS pour une échéance passée depuis longtemps', async () => {
    const { deps, trace } = make([auto()], [{ waId: '33611', valeur: '2026-08-22T09:00', dejaTirePour: null }]);
    expect(await runDateSweep(deps)).toBe(0);
    expect(trace.publies).toEqual([]);
  });

  it('🔴 ne publie PAS deux fois pour la même date', async () => {
    const { deps, trace } = make([auto()], [{ waId: '33611', valeur: '2026-08-23T14:00', dejaTirePour: '2026-08-23T14:00' }]);
    expect(await runDateSweep(deps)).toBe(0);
    expect(trace.publies).toEqual([]);
  });

  it('🔴 rendez-vous REPORTÉ : la date a changé, donc ça repart', async () => {
    const { deps, trace } = make([auto()], [{ waId: '33611', valeur: '2026-08-23T14:00', dejaTirePour: '2026-08-01T09:00' }]);
    expect(await runDateSweep(deps)).toBe(1);
    expect(trace.publies[0]?.valeur).toBe('2026-08-23T14:00');
  });

  it('l’événement porte l’identifiant de SON automation', async () => {
    // Sans lui, l'appel partirait sur toutes les automations de date de l'espace.
    const { deps, trace } = make(
      [auto({ id: 'a1' }), auto({ id: 'a2', triggerConfig: { fieldKey: 'rdv', delai: 2, unite: 'heures' } })],
      [{ waId: '33611', valeur: '2026-08-23T14:00', dejaTirePour: null }],
    );
    await runDateSweep(deps);
    expect(trace.publies.map((p) => p.automationId)).toEqual(['a1', 'a2']);
  });

  it('la fenêtre SQL est centrée sur « maintenant + délai », élargie d’un jour de chaque côté', async () => {
    // Le tri se fait sur du TEXTE : la marge absorbe les écarts de fuseau entre valeurs stockées. Filtrer
    // serré ferait manquer des rappels, et ça ne se verrait pas.
    const { deps, trace } = make([auto()], []);
    await runDateSweep(deps);
    const centre = MAINTENANT + 120 * 60_000;
    expect(trace.fenetres[0]?.basse).toBe(new Date(centre - 86_400_000).toISOString());
    expect(trace.fenetres[0]?.haute).toBe(new Date(centre + 86_400_000).toISOString());
  });

  it('une automation mal configurée est ignorée ET journalisée', async () => {
    const { deps, trace } = make([auto({ triggerConfig: { fieldKey: 'rdv', delai: 0, unite: 'heures' } })], [
      { waId: '33611', valeur: '2026-08-23T14:00', dejaTirePour: null },
    ]);
    expect(await runDateSweep(deps)).toBe(0);
    expect(trace.journal.join(' ')).toMatch(/mal configurée/);
  });

  it('🔴 une automation qui échoue n’empêche pas les autres de partir', async () => {
    let appel = 0;
    const { deps, trace } = make([auto({ id: 'a1' }), auto({ id: 'a2' })], [], {
      candidats: async () => {
        appel += 1;
        if (appel === 1) throw new Error('base indisponible');
        return [{ waId: '33611', valeur: '2026-08-23T14:00', dejaTirePour: null }];
      },
    });
    expect(await runDateSweep(deps)).toBe(1);
    expect(trace.publies[0]?.automationId).toBe('a2');
  });

  it('un fuseau illisible ne fait pas perdre l’espace entier', async () => {
    const { deps, trace } = make([auto()], [{ waId: '33611', valeur: '2026-08-23T14:00', dejaTirePour: null }], {
      timeZone: async () => { throw new Error('réglages illisibles'); },
    });
    expect(await runDateSweep(deps)).toBe(1);
    expect(trace.journal.join(' ')).toMatch(/fuseau illisible/);
  });
});
