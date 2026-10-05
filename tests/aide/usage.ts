import { GardeUsage } from '../../src/api/usage-guard.compteur';
import { CompteurDebitMemoire } from '../../src/db/debit.memoire';
import type { CompteurDebit } from '../../src/db/debit';

/**
 * LE GARDE D'USAGE D'UNE SEULE COPIE, POUR UN TEST : `GardeUsage` sur un compteur en mémoire, avec la signature que
 * les tests connaissaient (`minutesGardees`, plafond, horloge, places lourdes). En production, le même `GardeUsage`
 * compte dans la base (`buildServer` le construit sur le compteur que `src/index.ts` lui passe).
 *
 * `compteur` : deux gardes qui reçoivent le même sont deux copies de l'API qui partagent la base.
 */
export class GardeUsageMemoire extends GardeUsage {
  constructor(
    minutesGardees = 120,
    plafondUnitesParEspace = 0,
    maintenant: () => number = () => Date.now(),
    maxLourdesSimultanees = 1,
    compteur: CompteurDebit = new CompteurDebitMemoire(maintenant),
  ) {
    // Sans quotas quotidiens, dit explicitement : les tests des quotas construisent `GardeUsage` avec les leurs.
    super(compteur, null, { minutesGardees, plafondUnitesParEspace, maxLourdesSimultanees });
  }
}
