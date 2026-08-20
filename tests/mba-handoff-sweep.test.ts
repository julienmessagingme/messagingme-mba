import { describe, it, expect } from 'vitest';
import { runHandoffSweep } from '../src/mba/handoff-sweep';
import type { HandoffSweepDeps } from '../src/mba/handoff-sweep';
import type { EtatHandoff } from '../src/mba/handoff';
import type { BusinessHours } from '../src/workflow/conditions';

/** Lun-Ven 9h-18h, week-end fermé. */
const HEURES: BusinessHours = {
  '0': { closed: true, open: '', close: '' },
  '1': { closed: false, open: '09:00', close: '18:00' },
  '2': { closed: false, open: '09:00', close: '18:00' },
  '3': { closed: false, open: '09:00', close: '18:00' },
  '4': { closed: false, open: '09:00', close: '18:00' },
  '5': { closed: false, open: '09:00', close: '18:00' },
  '6': { closed: true, open: '', close: '' },
};

/** Jeudi 21 août 2026, 10 h et 23 h à Paris. */
const OUVERT = Date.parse('2026-08-20T10:00:00+02:00');
const FERME = Date.parse('2026-08-20T23:00:00+02:00');

function deps({ actuel = false, now, ...over }: Omit<Partial<HandoffSweepDeps>, 'now'> & { actuel?: EtatHandoff; now: number }): {
  d: HandoffSweepDeps; ecrits: Array<{ tenantId: string; enabled: boolean }>;
} {
  const ecrits: Array<{ tenantId: string; enabled: boolean }> = [];
  const d: HandoffSweepDeps = {
    tenantsHandoffSurHoraires: async () => [{ tenantId: 't1', timezone: 'Europe/Paris', businessHours: HEURES }],
    lireHandoffEnabled: async () => actuel,
    ecrireHandoffEnabled: async (tenantId, enabled) => { ecrits.push({ tenantId, enabled }); },
    ...over,
    now: () => now,
  };
  return { d, ecrits };
}

describe('runHandoffSweep : Meta n’a aucune notion d’horaires, ce balayage la lui donne', () => {
  it('dans les heures d’ouverture -> allume le passage de main', async () => {
    const { d, ecrits } = deps({ now: OUVERT, actuel: false });
    expect(await runHandoffSweep(d)).toBe(1);
    expect(ecrits).toEqual([{ tenantId: 't1', enabled: true }]);
  });

  it('hors des heures d’ouverture -> l’éteint', async () => {
    const { d, ecrits } = deps({ now: FERME, actuel: true });
    expect(await runHandoffSweep(d)).toBe(1);
    expect(ecrits).toEqual([{ tenantId: 't1', enabled: false }]);
  });

  it('🔴 état déjà conforme -> N’ÉCRIT PAS (sinon on réécrit la configuration toutes les 5 minutes)', async () => {
    const { d, ecrits } = deps({ now: OUVERT, actuel: true });
    expect(await runHandoffSweep(d)).toBe(0);
    expect(ecrits).toEqual([]);
  });

  it('🔴 état illisible (pas de numéro, agent absent) -> ne touche à RIEN', async () => {
    const { d, ecrits } = deps({ now: OUVERT, actuel: null });
    expect(await runHandoffSweep(d)).toBe(0);
    expect(ecrits).toEqual([]);
  });

  it('🔴 handoff JAMAIS configuré -> écrit, même quand la valeur voulue est `false`', async () => {
    // Sans ce cas, un agent neuf hors horaires ne serait jamais initialisé : « jamais configuré » et
    // « configuré à false » se ressemblent, mais le premier laisse l'agent dans un état qu'on ne connaît pas.
    const { d, ecrits } = deps({ now: FERME, actuel: 'absent' });
    expect(await runHandoffSweep(d)).toBe(1);
    expect(ecrits).toEqual([{ tenantId: 't1', enabled: false }]);
  });

  it('un tenant en échec n’empêche pas les autres de basculer', async () => {
    const ecrits: Array<string> = [];
    const n = await runHandoffSweep({
      tenantsHandoffSurHoraires: async () => [
        { tenantId: 'ko', timezone: 'Europe/Paris', businessHours: HEURES },
        { tenantId: 'ok', timezone: 'Europe/Paris', businessHours: HEURES },
      ],
      lireHandoffEnabled: async (t) => { if (t === 'ko') throw new Error('Meta injoignable'); return false; },
      ecrireHandoffEnabled: async (t) => { ecrits.push(t); },
      now: () => OUVERT,
    });
    expect(n).toBe(1);
    expect(ecrits).toEqual(['ok']);
  });

  it('une écriture en échec est comptée comme non faite, et rattrapée au passage suivant', async () => {
    const n = await runHandoffSweep({
      tenantsHandoffSurHoraires: async () => [{ tenantId: 't1', timezone: 'Europe/Paris', businessHours: HEURES }],
      lireHandoffEnabled: async () => false,
      ecrireHandoffEnabled: async () => { throw new Error('502'); },
      now: () => OUVERT,
    });
    expect(n).toBe(0);
  });

  it('le fuseau du tenant décide : 10 h à Paris, c’est fermé à New York', async () => {
    const { d, ecrits } = deps({
      now: OUVERT,
      actuel: true,
      tenantsHandoffSurHoraires: async () => [{ tenantId: 't1', timezone: 'America/New_York', businessHours: HEURES }],
    });
    expect(await runHandoffSweep(d)).toBe(1); // 4 h du matin là-bas
    expect(ecrits).toEqual([{ tenantId: 't1', enabled: false }]);
  });
});
