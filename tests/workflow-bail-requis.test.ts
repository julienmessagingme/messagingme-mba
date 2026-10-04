import { describe, it, expect } from 'vitest';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';

/**
 * 🔴 LA GARDE ANTI-DOUBLE-ENVOI EST REQUISE PAR LE CONTRAT (piste 8 du rapport d'architecture du 2026-10-02).
 *
 * `reserverAvance`, `prolongerAvance` et `libererAvance` étaient optionnelles « pour les fixtures » : un câblage qui
 * les oubliait compilait, se déployait, et deux messages simultanés du même contact faisaient partir deux fois la
 * suite du parcours, facturée deux fois. Elles sont requises, et ce fichier le tient AU TYPECHECK : chaque
 * `@ts-expect-error` ci-dessous exige que l'absence d'UNE des trois soit une erreur. Si l'une redevenait optionnelle,
 * sa directive deviendrait inutile et `npm run typecheck` échouerait (« Unused '@ts-expect-error' directive »).
 * Une seule directive pour les trois ne suffirait pas : deux absentes la satisferaient encore.
 *
 * ⚠️ Il remplace le cas « un store SANS réservation garde le comportement d'avant » de
 * `workflow-avance-concurrente.test.ts`, qui masquait les fonctions à l'exécution : ce store-là ne compile plus, et
 * le cas, resté vert après le changement, ne vérifiait plus ce que son titre disait (relecture du 2026-10-04).
 */
type Runs = WorkflowExecutorDeps['runs'];

describe('la garde anti-double-envoi est requise par le contrat de l’exécuteur', () => {
  it('🔴 un `runs` sans réservation, sans battement ou sans libération ne compile pas', () => {
    const sansReserver = {} as Omit<Runs, 'reserverAvance'>;
    const sansProlonger = {} as Omit<Runs, 'prolongerAvance'>;
    const sansLiberer = {} as Omit<Runs, 'libererAvance'>;
    // @ts-expect-error `reserverAvance` est requise : sans elle, aucune réservation, donc le double envoi.
    const a: Runs = sansReserver;
    // @ts-expect-error `prolongerAvance` est requise : sans elle, un envoi long perd son tour en plein travail.
    const b: Runs = sansProlonger;
    // @ts-expect-error `libererAvance` est requise : sans elle, le message suivant attend la fin du bail.
    const c: Runs = sansLiberer;
    expect([a, b, c]).toHaveLength(3);
  });
});
