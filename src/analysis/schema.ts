import { z } from 'zod';

export const SENTIMENTS = ['positif', 'neutre', 'negatif'] as const;
/**
 * Les intentions d'une conversation. Cette liste fait foi : le prompt, le CHECK en base
 * (`conversation_analysis_intent_check`), les statistiques et la console (`web/lib/intentions.ts`) la suivent,
 * tenus par `tests/intentions-parite.test.ts`. `autre` reste le dernier recours du modèle et la dernière barre.
 *
 * 🔴 Ajouter une valeur demande une migration qui relâche le CHECK, appliquée avant le déploiement : sans elle,
 * l'INSERT échoue en 23514 et le job rejoue, appel au modèle compris, jusqu'à la DLQ.
 */
export const INTENTS = ['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'achat', 'suivi_commande', 'retour', 'autre'] as const;
export type Intent = (typeof INTENTS)[number];
export const ACTIONS = ['creer_devis', 'rappeler', 'relancer', 'escalader', 'aucune'] as const;
export const HANDLED_BY = ['humain', 'automatise', 'mba'] as const;
export type HandledBy = (typeof HANDLED_BY)[number];

/**
 * Bornes de l'échelle des deux notes (satisfaction, urgence). Elle existe aussi dans le CHECK de la migration 0121
 * et dans le front, tenus par `tests/analysis-engine.test.ts` et `web/lib/nuage.test.ts` : la changer ici seule
 * ferait échouer l'INSERT de l'analyse en boucle. Élargir l'échelle demande une migration de plus.
 */
export const NOTE_MIN = 0;
export const NOTE_MAX = 10;

/**
 * Une note de 0 à 10 rendue par le modèle, tolérante : `.catch(undefined)` évite qu'une note invalide fasse échouer
 * `safeParse` sur l'objet entier et perdre toute l'analyse.
 * `8.5` et `"9"` sont lus (le modèle a bien rendu une mesure) ; `12`, `-1`, `"huit"`, `null` deviennent absents :
 * ramener une valeur hors échelle à la borne inventerait une donnée, et l'absence veut dire « pas de mesure ».
 */
const note0a10 = z
  .preprocess((v) => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : v;
  }, z.number().int().min(NOTE_MIN).max(NOTE_MAX))
  .optional()
  .catch(undefined);

/**
 * Sortie attendue du LLM. `handled_by` et `exchanges_count` ne lui sont pas demandés : ce sont des faits calculés
 * en code. Agnostique du CRM : `action_suggestion` reste une intention d'action, que le connecteur traduit.
 */
export const llmOutputSchema = z.object({
  sentiment: z.enum(SENTIMENTS),
  intent: z.enum(INTENTS),
  topic: z.string().trim().min(1).max(120),
  resolved: z.boolean(),
  entities: z.record(z.string(), z.unknown()).default({}),
  action_suggestion: z.enum(ACTIONS),
  confidence: z.number().min(0).max(1),
  justification: z.string().trim().min(1).max(2000),
  /**
   * Ce qui s'est dit, en deux ou trois phrases (`justification`, elle, explique le classement).
   * `.optional()` et non `.default('')` : un modèle qui l'omet n'invalide pas l'analyse, et l'absence reste
   * distinguable d'un résumé vide, que l'écran ne dit pas de la même façon.
   */
  summary: z.string().trim().max(800).optional(),
  /**
   * Le client a-t-il été injurieux ou agressif envers l'entreprise ? `.default(false)` : un modèle qui l'omet
   * n'invalide pas l'analyse. Ce n'est qu'un constat qui alimente une liste à relire : bloquer reste humain.
   */
  abusive: z.boolean().default(false),
  /**
   * Où en est le client (0 = très mécontent, 10 = très satisfait) et à quel point ça presse (0 = aucune attente,
   * 10 = réponse immédiate attendue).
   * `undefined` veut dire « pas de mesure », jamais `0` (colonne nullable pour la même raison) : les compter comme
   * zéro rangerait l'historique dans le coin « client furieux, urgence nulle ».
   */
  satisfaction: note0a10,
  urgence: note0a10,
});
export type LlmOutput = z.infer<typeof llmOutputSchema>;

/** Analyse complète stockée = sortie LLM + faits déterministes. */
export interface ConversationAnalysis extends LlmOutput {
  handled_by: HandledBy;
  exchanges_count: number;
}
