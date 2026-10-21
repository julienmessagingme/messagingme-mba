import { describe, it, expect } from 'vitest';
import { reconcilierHandoffSurHoraires } from '../src/mba/handoff';
import type { PilotageHandoffDeps } from '../src/mba/handoff';
import type { MbaClient, AgentSettings } from '../src/mba/client';
import type { BusinessHours } from '../src/workflow/conditions';

const HEURES: BusinessHours = {
  '0': { closed: true, open: '', close: '' },
  '1': { closed: false, open: '09:00', close: '18:00' },
  '2': { closed: false, open: '09:00', close: '18:00' },
  '3': { closed: false, open: '09:00', close: '18:00' },
  '4': { closed: false, open: '09:00', close: '18:00' },
  '5': { closed: false, open: '09:00', close: '18:00' },
  '6': { closed: true, open: '', close: '' },
};

const OUVERT = Date.parse('2026-08-20T10:00:00+02:00');
const FERME = Date.parse('2026-08-20T23:00:00+02:00');

function deps(options: {
  now: number;
  actuel?: boolean | 'absent' | null;
  timezone?: string;
  tenants?: string[];
  lectureEchoue?: string;
  ecritureEchoue?: string;
}): { deps: PilotageHandoffDeps; ecrits: Array<{ tenantId: string; enabled: boolean }> } {
  const ecrits: Array<{ tenantId: string; enabled: boolean }> = [];
  const tenants = options.tenants ?? ['t1'];
  const actuel = options.actuel === undefined ? false : options.actuel;
  const client = (tenantId: string) => ({
    getSettings: async (): Promise<AgentSettings | null> => {
      if (options.lectureEchoue === tenantId) throw new Error('Meta injoignable');
      if (actuel === null) return null;
      if (actuel === 'absent') return { agent_id: 'AG1' };
      return { agent_id: 'AG1', handoff: { enabled: actuel } };
    },
    putSettings: async (_pn: string, corps: Record<string, unknown>) => {
      if (options.ecritureEchoue === tenantId) throw new Error('502');
      const enabled = (corps.handoff as { enabled: boolean }).enabled;
      ecrits.push({ tenantId, enabled });
      return {};
    },
  } as unknown as MbaClient);
  return {
    deps: {
      reglages: {
        setMbaHandoffMode: async () => {},
        get: async () => ({ timezone: options.timezone ?? 'Europe/Paris', businessHours: HEURES }),
        tenantsHandoffSurHoraires: async () => tenants.map((tenantId) => ({
          tenantId,
          timezone: options.timezone ?? 'Europe/Paris',
          businessHours: HEURES,
        })),
      },
      numeros: { getTenantPhoneNumberId: async () => 'PN1' },
      meta: { mbaClientForTenant: async (tenantId) => client(tenantId) },
      now: () => options.now,
    },
    ecrits,
  };
}

describe('reconcilierHandoffSurHoraires', () => {
  it('dans les heures d’ouverture, active le passage de main', async () => {
    const cible = deps({ now: OUVERT, actuel: false });
    expect(await reconcilierHandoffSurHoraires(cible.deps)).toBe(1);
    expect(cible.ecrits).toEqual([{ tenantId: 't1', enabled: true }]);
  });

  it('hors des heures d’ouverture, le désactive', async () => {
    const cible = deps({ now: FERME, actuel: true });
    expect(await reconcilierHandoffSurHoraires(cible.deps)).toBe(1);
    expect(cible.ecrits).toEqual([{ tenantId: 't1', enabled: false }]);
  });

  it('n’écrit pas quand Meta est déjà conforme ou qu’aucune cible n’est lisible', async () => {
    const conforme = deps({ now: OUVERT, actuel: true });
    expect(await reconcilierHandoffSurHoraires(conforme.deps)).toBe(0);
    expect(conforme.ecrits).toEqual([]);
    const absente = deps({ now: OUVERT, actuel: null });
    expect(await reconcilierHandoffSurHoraires(absente.deps)).toBe(0);
    expect(absente.ecrits).toEqual([]);
  });

  it('initialise un handoff absent même quand la valeur voulue est false', async () => {
    const cible = deps({ now: FERME, actuel: 'absent' });
    expect(await reconcilierHandoffSurHoraires(cible.deps)).toBe(1);
    expect(cible.ecrits).toEqual([{ tenantId: 't1', enabled: false }]);
  });

  it('isole les échecs de lecture et d’écriture pour poursuivre les autres tenants', async () => {
    const lecture = deps({ now: OUVERT, tenants: ['ko', 'ok'], lectureEchoue: 'ko' });
    expect(await reconcilierHandoffSurHoraires(lecture.deps)).toBe(1);
    expect(lecture.ecrits).toEqual([{ tenantId: 'ok', enabled: true }]);
    const ecriture = deps({ now: OUVERT, tenants: ['ko', 'ok'], ecritureEchoue: 'ko' });
    expect(await reconcilierHandoffSurHoraires(ecriture.deps)).toBe(1);
    expect(ecriture.ecrits).toEqual([{ tenantId: 'ok', enabled: true }]);
  });

  it('le fuseau du tenant décide : 10 h à Paris est encore fermé à New York', async () => {
    const cible = deps({ now: OUVERT, actuel: true, timezone: 'America/New_York' });
    expect(await reconcilierHandoffSurHoraires(cible.deps)).toBe(1);
    expect(cible.ecrits).toEqual([{ tenantId: 't1', enabled: false }]);
  });
});
