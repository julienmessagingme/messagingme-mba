import { describe, it, expect } from 'vitest';
import { MODES_REPONDEUR, modeEffectif, type ModeRepondeur } from '../web/lib/partage/repondeur-modes';
import { modeEffectifDesReglages } from '../web/lib/repondeur';

/**
 * « QUI RÉPOND AU CLIENT » (RC6) : la liste des modes, les bornes du délai et le mode effectif sont PARTAGÉS
 * (`web/lib/partage/repondeur-modes.ts`). Reste à prouver ce que le partage ne garantit pas : la lecture défensive de
 * la console (`modeEffectifDesReglages`, qui reçoit du JSON) passe les bons champs au calcul partagé.
 */
describe('la lecture de la console donne le mode effectif du serveur', () => {
  it('🔴 le même mode effectif, pour chaque mode écrit, cible présente ou absente, agent de Meta allumé ou non', () => {
    for (const repondeurMode of MODES_REPONDEUR as readonly ModeRepondeur[]) {
      for (const mbaEnabled of [true, false]) {
        for (const cible of [null, 'x']) {
          const r = { mbaEnabled, repondeurMode, repondeurAgentId: cible, repondeurWorkflowId: cible, repondeurAdresseId: cible };
          expect(modeEffectifDesReglages(r), JSON.stringify(r)).toBe(modeEffectif(r));
        }
      }
    }
  });
});
