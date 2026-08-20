import { describe, it, expect } from 'vitest';
import { lireHandoffEnabled, ecrireHandoffEnabled } from '../src/mba/handoff';
import type { HandoffCibleDeps } from '../src/mba/handoff';
import type { MbaClient, AgentSettings } from '../src/mba/client';

/** Faux client : seules `getSettings` et `putSettings` sont touchées ici. */
function cible(settings: AgentSettings | null, pn: string | null = 'PN1'): {
  deps: HandoffCibleDeps; puts: Array<Record<string, unknown>>;
} {
  const puts: Array<Record<string, unknown>> = [];
  const client = {
    getSettings: async () => settings,
    putSettings: async (_pn: string, corps: Record<string, unknown>) => { puts.push(corps); return {}; },
  } as unknown as MbaClient;
  return { deps: { clientFor: async () => client, phoneNumberFor: async () => pn }, puts };
}

describe('lireHandoffEnabled : « jamais configuré » n’est PAS « configuré à false »', () => {
  it('handoff.enabled lu chez Meta -> la valeur', async () => {
    expect(await lireHandoffEnabled(cible({ handoff: { enabled: true } }).deps, 't1')).toBe(true);
    expect(await lireHandoffEnabled(cible({ handoff: { enabled: false } }).deps, 't1')).toBe(false);
  });

  it('🔴 réglages lisibles mais handoff ABSENT -> « absent », pas false', async () => {
    // Meta le documente : « Null if not configured ». Rendre `false` ferait croire au balayage que l'agent
    // est déjà dans l'état voulu, et un agent neuf ne serait jamais configuré.
    expect(await lireHandoffEnabled(cible({ agent_id: 'AG1' }).deps, 't1')).toBe('absent');
    expect(await lireHandoffEnabled(cible({ handoff: {} }).deps, 't1')).toBe('absent');
    expect(await lireHandoffEnabled(cible({ handoff: { message: 'coucou' } }).deps, 't1')).toBe('absent');
  });

  it('pas de numéro, ou agent pas encore créé par Meta -> null (ne rien écrire)', async () => {
    expect(await lireHandoffEnabled(cible({ handoff: { enabled: true } }, null).deps, 't1')).toBeNull();
    expect(await lireHandoffEnabled(cible(null).deps, 't1')).toBeNull();
  });
});

describe('ecrireHandoffEnabled', () => {
  it('écrit enabled en préservant le reste des réglages ET le reste de handoff', async () => {
    const actuel: AgentSettings = {
      agent_id: 'AG1',
      never_say_phrases: ['jamais ça'],
      handoff: { enabled: true, message: 'Un conseiller arrive.', message_selection: 'CUSTOM' },
    };
    const { deps, puts } = cible(actuel);
    await ecrireHandoffEnabled(deps, 't1', false);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.handoff).toEqual({ enabled: false, message: 'Un conseiller arrive.', message_selection: 'CUSTOM' });
    expect(puts[0]?.never_say_phrases).toEqual(['jamais ça']); // le PUT est un remplacement complet
  });

  it('sans numéro : ne tape pas Meta du tout', async () => {
    const { deps, puts } = cible({ handoff: { enabled: true } }, null);
    await ecrireHandoffEnabled(deps, 't1', false);
    expect(puts).toEqual([]);
  });
});
