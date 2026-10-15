/**
 * La sortie « Formulaire rempli » du bloc Formulaire (Julien, 2026-10-15). Son autre sortie, « Toute autre réponse »,
 * est l'arête LIBRE, sans poignée (`web/lib/workflow-sorties.ts`). Le moteur route et le canevas dessine sur CETTE
 * valeur : un littéral qui divergerait d'une lettre ne correspondrait à aucune arête, et le formulaire rempli
 * partirait par « Toute autre réponse » sans erreur nulle part.
 */
export const SORTIE_FORMULAIRE_REMPLI = 'rempli';
