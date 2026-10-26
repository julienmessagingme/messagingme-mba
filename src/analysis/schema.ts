import { z } from 'zod';
import { ACTIONS, INTENTS, NOTE_MAX, NOTE_MIN, SENTIMENTS, type HandledBy } from '../../web/lib/partage/analyse';

/**
 * Les codes d'une analyse (sentiments, intentions, actions, « traitée par ») sont partagés avec la console
 * (`web/lib/partage/analyse.ts`). 🔴 Ajouter une intention demande une migration qui relâche le CHECK, appliquée avant
 * le déploiement : sans elle, l'INSERT échoue en 23514 et le job rejoue, appel au modèle compris, jusqu'à la DLQ.
 */
export { ACTIONS, HANDLED_BY, INTENTS, NOTE_MAX, NOTE_MIN, SENTIMENTS, type HandledBy, type Intent } from '../../web/lib/partage/analyse';

/**
 * Longueur maximale du sujet. Le CHECK de `contacts.analyse_sujet` (migration 0196) la porte aussi, tenu par
 * `tests/fiche-analyse-migration.test.ts` : un sujet que Zod accepte et que la base refuse ferait échouer la
 * transaction de `save`, analyse comprise.
 */
export const SUJET_MAX = 120;

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
  topic: z.string().trim().min(1).max(SUJET_MAX),
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
