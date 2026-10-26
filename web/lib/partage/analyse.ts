/**
 * Les codes d'une analyse de conversation : le serveur les écrit (le modèle les choisit, la base les contraint), l'API
 * les rend, la console les traduit. Leurs libellés restent côté console (`web/lib/analyse.ts`, `web/lib/intentions.ts`).
 */

export const SENTIMENTS = ['positif', 'neutre', 'negatif'] as const;

/**
 * Les intentions d'une conversation. Le prompt, le CHECK en base (`conversation_analysis_intent_check`), les
 * statistiques et la console suivent cette liste, tenus par `tests/intentions-parite.test.ts`. `autre` reste le dernier
 * recours du modèle et la dernière barre. L'ordre est celui de l'affichage, et il est FIXE : un classement par volume
 * ferait danser les barres d'une période à l'autre.
 *
 * 🔴 Ajouter une valeur demande une migration qui relâche le CHECK, appliquée avant le déploiement : sans elle,
 * l'INSERT échoue en 23514 et le job rejoue, appel au modèle compris, jusqu'à la DLQ.
 */
export const INTENTS = [
  'demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'achat', 'suivi_commande', 'retour', 'autre',
] as const;
export type Intent = (typeof INTENTS)[number];

export const ACTIONS = ['creer_devis', 'rappeler', 'relancer', 'escalader', 'aucune'] as const;

export const HANDLED_BY = ['humain', 'automatise', 'mba'] as const;
export type HandledBy = (typeof HANDLED_BY)[number];

/**
 * Bornes de l'échelle des deux notes (satisfaction, urgence) : le prompt et la validation de l'analyse, les filtres de la
 * fiche, l'axe du nuage de la console. 🔴 Le CHECK des migrations 0121 et 0196 les porte aussi, tenu par
 * `tests/analysis-engine.test.ts` et `tests/fiche-analyse-migration.test.ts` : les changer ici seules ferait échouer
 * l'INSERT de l'analyse en boucle. Élargir l'échelle demande une migration de plus.
 */
export const NOTE_MIN = 0;
export const NOTE_MAX = 10;
