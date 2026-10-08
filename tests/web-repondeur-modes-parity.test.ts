import { describe, it, expect } from 'vitest';
import {
  DELAI_SCENARIO_HEURES_DEFAUT, DELAI_SCENARIO_HEURES_MAX, DELAI_SCENARIO_HEURES_MIN, MODES_REPONDEUR, modeEffectif,
  type ModeRepondeur,
} from '../src/repondeur/mode';
import {
  DELAI_HEURES_DEFAUT, DELAI_HEURES_MAX, DELAI_HEURES_MIN, MODES_REPONDEUR as MODES_ECRAN, modeEffectifDesReglages,
} from '../web/lib/repondeur';

/**
 * « QUI RÉPOND AU CLIENT » EXISTE EN DEUX EXEMPLAIRES (RC6), et ce test les tient alignés : la liste des modes et les
 * bornes du délai sont recopiées dans la console (`web/lib/repondeur.ts`) pour ne pas tirer du code serveur dans le
 * bundle client. Un mode connu du serveur seul ne s'afficherait pas sur la carte ; un mode connu de l'écran seul serait
 * refusé par la route. ⚠️ Un test serveur qui LIT un fichier de la console : il se pousse avec lui.
 */
describe('parité des modes du répondeur entre le serveur et la console', () => {
  it('🔴 les mêmes modes, dans le même ordre', () => {
    expect([...MODES_ECRAN]).toEqual([...MODES_REPONDEUR]);
  });

  it('🔴 les mêmes bornes du délai, en heures', () => {
    expect([DELAI_HEURES_MIN, DELAI_HEURES_DEFAUT, DELAI_HEURES_MAX]).toEqual([DELAI_SCENARIO_HEURES_MIN, DELAI_SCENARIO_HEURES_DEFAUT, DELAI_SCENARIO_HEURES_MAX]);
  });

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
