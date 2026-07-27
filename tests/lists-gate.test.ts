import { describe, it, expect } from 'vitest';
import { listsGateOpen } from '../src/crm/lists-gate';

describe('listsGateOpen (gate dérivé des campagnes via listes HubSpot, F3-b)', () => {
  it('ouvert seulement si l\'utilisateur a activé les listes ET qu\'aucun numéro n\'est en pause', () => {
    expect(listsGateOpen(true, false)).toBe(true); // activé, pas de pause -> ouvert
    expect(listsGateOpen(true, true)).toBe(false); // activé mais EN PAUSE -> fermé (la pause prime)
    expect(listsGateOpen(false, false)).toBe(false); // réglage OFF -> fermé
    expect(listsGateOpen(false, true)).toBe(false); // OFF + pause -> fermé
  });

  it('la pause ne dépend pas du réglage : quel que soit hubspotListsEnabled, une pause ferme le gate', () => {
    for (const enabled of [true, false]) expect(listsGateOpen(enabled, true)).toBe(false);
  });
});
