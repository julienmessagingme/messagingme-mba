import { describe, it, expect } from 'vitest';
import { reglerModeHandoff } from '../src/mba/handoff';
import type { PilotageHandoffDeps } from '../src/mba/handoff';
import type { MbaClient, AgentSettings } from '../src/mba/client';
import type { MbaHandoffMode } from '../src/settings/store.pg';
import type { BusinessHours } from '../src/workflow/conditions';

const FERME: BusinessHours = Object.fromEntries(
  [0, 1, 2, 3, 4, 5, 6].map((jour) => [String(jour), { closed: true, open: '', close: '' }]),
);

function pilotage(options: {
  settings?: AgentSettings | null;
  numero?: string | null;
  putEchoue?: boolean;
  now?: number;
} = {}): {
  deps: PilotageHandoffDeps;
  modes: MbaHandoffMode[];
  puts: Array<Record<string, unknown>>;
} {
  const modes: MbaHandoffMode[] = [];
  const puts: Array<Record<string, unknown>> = [];
  const settings = options.settings === undefined ? { agent_id: 'AG1', handoff: { enabled: false } } : options.settings;
  const client = {
    getSettings: async () => settings,
    putSettings: async (_pn: string, corps: Record<string, unknown>) => {
      if (options.putEchoue) throw new Error('502');
      puts.push(corps);
      return {};
    },
  } as unknown as MbaClient;
  return {
    deps: {
      reglages: {
        setMbaHandoffMode: async (_tenant, mode) => { modes.push(mode); },
        horairesEffectifs: async () => ({ timezone: 'Europe/Paris', businessHours: FERME }),
        tenantsHandoffSurHoraires: async () => [],
      },
      numeros: { getTenantPhoneNumberId: async () => options.numero === undefined ? 'PN1' : options.numero },
      meta: { mbaClientForTenant: async () => client },
      now: () => options.now ?? Date.parse('2026-08-20T10:00:00+02:00'),
    },
    modes,
    puts,
  };
}

describe('reglerModeHandoff : un seul protocole possède le choix et son application Meta', () => {
  it('« toujours » persiste le choix puis active le passage de main', async () => {
    const { deps, modes, puts } = pilotage();
    expect(await reglerModeHandoff(deps, 't1', 'always')).toEqual({ appliqueChezMeta: true });
    expect(modes).toEqual(['always']);
    expect(puts[0]?.handoff).toEqual({ enabled: true });
  });

  it('« jamais » préserve les autres réglages et les autres champs de handoff', async () => {
    const actuel: AgentSettings = {
      agent_id: 'AG1',
      never_say_phrases: ['jamais ça'],
      handoff: { enabled: true, message: 'Un conseiller arrive.', message_selection: 'CUSTOM' },
    };
    const { deps, puts } = pilotage({ settings: actuel });
    await reglerModeHandoff(deps, 't1', 'never');
    expect(puts[0]?.handoff).toEqual({ enabled: false, message: 'Un conseiller arrive.', message_selection: 'CUSTOM' });
    expect(puts[0]?.never_say_phrases).toEqual(['jamais ça']);
  });

  it('« heures d’ouverture » calcule la valeur de l’instant avec les horaires persistés', async () => {
    const { deps, modes, puts } = pilotage();
    expect(await reglerModeHandoff(deps, 't1', 'business_hours')).toEqual({ appliqueChezMeta: true });
    expect(modes).toEqual(['business_hours']);
    expect(puts[0]?.handoff).toEqual({ enabled: false });
  });

  it('une panne Meta ne retire pas le choix enregistré et sera rattrapée par le balayage', async () => {
    const { deps, modes } = pilotage({ putEchoue: true });
    expect(await reglerModeHandoff(deps, 't1', 'always')).toEqual({ appliqueChezMeta: false });
    expect(modes).toEqual(['always']);
  });

  it('sans numéro, le choix est enregistré et l’application reste un no-op réussi comme avant', async () => {
    const { deps, modes, puts } = pilotage({ numero: null });
    expect(await reglerModeHandoff(deps, 't1', 'never')).toEqual({ appliqueChezMeta: true });
    expect(modes).toEqual(['never']);
    expect(puts).toEqual([]);
  });
});
