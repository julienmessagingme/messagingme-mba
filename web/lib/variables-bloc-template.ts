import { varCountOf } from './fields';

/**
 * Module PUR : à quoi correspond chaque `{{n}}` du corps d'un template envoyé par un bloc de scénario.
 *
 * Le bloc ne règle aucune variable : hors campagne, le moteur lit les indices posés sur le template à sa
 * création (`template_param_hints`, `src/workflow/envois-bloc.ts`), et une position sans indice fait REFUSER
 * l'envoi (`resolveHintParams`). Le panneau du bloc le montre au lieu de le laisser découvrir à l'envoi.
 */

/** Ligne affichée : la position, et la source de son indice, ou `null` si aucun champ n'y est relié. */
export interface VariableDuBloc<S> { position: number; source: S | null }

export function variablesDuBloc<S>(body: string | undefined | null, hints: Array<{ position: number; source: S }>): Array<VariableDuBloc<S>> {
  const parPosition = new Map(hints.map((h) => [h.position, h.source]));
  return Array.from({ length: varCountOf(body) }, (_, i) => ({ position: i + 1, source: parPosition.get(i + 1) ?? null }));
}
