import { z } from 'zod';

export const SENTIMENTS = ['positif', 'neutre', 'negatif'] as const;
/**
 * Les intentions d'une conversation. CETTE LISTE FAIT FOI : le prompt (`src/analysis/engine.ts`), le CHECK en
 * base (dernière migration qui pose `conversation_analysis_intent_check`), les statistiques et la copie de la
 * console (`web/lib/intentions.ts`) la suivent, et `tests/intentions-parite.test.ts` exige qu'ils nomment
 * exactement les mêmes valeurs.
 *
 * `achat`, `suivi_commande` et `retour` (spec du 2026-09-24, § 7) : les six premières étaient celles des
 * services et de l'assurance, aucune ne disait « veut acheter ». Insérées AVANT `autre`, qui reste le dernier
 * recours du modèle et la dernière barre des écrans.
 *
 * 🔴 AJOUTER UNE VALEUR DEMANDE UNE MIGRATION qui relâche le CHECK, appliquée AVANT le déploiement : sans
 * elle, l'INSERT de l'analyse échoue en 23514 et le job la rejoue, appel au modèle compris, jusqu'à la DLQ.
 */
export const INTENTS = ['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'achat', 'suivi_commande', 'retour', 'autre'] as const;
export type Intent = (typeof INTENTS)[number];
export const ACTIONS = ['creer_devis', 'rappeler', 'relancer', 'escalader', 'aucune'] as const;
export const HANDLED_BY = ['humain', 'automatise', 'mba'] as const;
export type HandledBy = (typeof HANDLED_BY)[number];

/**
 * Bornes de l'échelle des deux notes (satisfaction, urgence).
 *
 * 🔴 CETTE ÉCHELLE EXISTE EN TROIS EXEMPLAIRES, et les deux autres sont TENUS PAR DES TESTS, plus par cette
 * phrase : le CHECK de la migration 0121 (`tests/analysis-engine.test.ts`) et les constantes du front
 * (`web/lib/nuage.test.ts`, qui lit ce fichier-ci). La changer ici seule ferait échouer l'INSERT de
 * l'analyse entière, en boucle et en silence, pour une note hors du CHECK. Et une migration appliquée ne se
 * corrige pas : élargir l'échelle demande une migration DE PLUS.
 */
export const NOTE_MIN = 0;
export const NOTE_MAX = 10;

/**
 * Une note de 0 à 10 rendue par le modèle, TOLÉRANTE, parce qu'elle ne vaut pas une analyse perdue.
 *
 * `.catch(undefined)` et non une simple validation : sans lui, un modèle qui rend `12` ou `"8"` ferait
 * échouer `safeParse` sur l'objet ENTIER, donc perdrait le sentiment, l'intention, le résumé et le reste
 * pour une note. Même arbitrage qu'`abusive` et `summary`, écrit ici pour la même raison : une analyse
 * perdue coûte plus cher qu'une mesure manquée.
 *
 * ⚠️ Ce qui est TOLÉRÉ et ce qui ne l'est pas, et pourquoi la frontière est là (mesuré sur zod 4.4) :
 * - `8.5` devient `9` et `"9"` devient `9` : le modèle a bien rendu une mesure, la jeter perdrait ce qu'il
 *   a dit alors qu'on sait le lire ;
 * - `12`, `-1`, `"huit"`, `null` deviennent ABSENTS : ramener une valeur hors échelle à la borne
 *   inventerait une donnée, et l'absence a déjà un sens exact ici, « pas de mesure ».
 */
const note0a10 = z
  .preprocess((v) => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : v;
  }, z.number().int().min(NOTE_MIN).max(NOTE_MAX))
  .optional()
  .catch(undefined);

/**
 * Sortie ATTENDUE du LLM (validée). `handled_by` et `exchanges_count` NE sont PAS demandés au LLM : ce sont des
 * FAITS déterministes calculés en code (moins de coût, jamais faux). Générique/agnostique du CRM : `action_suggestion`
 * reste un intent d'action, la traduction vers une action HubSpot est le job du connecteur (pièce 2).
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
   * Ce qui s'est DIT, en deux ou trois phrases. À ne pas confondre avec `justification`, qui explique le
   * classement : un lecteur qui ouvre la fiche d'une conversation veut d'abord savoir de quoi elle parlait,
   * pas pourquoi le modèle a proposé de rappeler.
   *
   * `.optional()` et non `.default('')` : un modèle qui l'omet ne doit pas invalider toute l'analyse (même
   * raison que `abusive`), et l'absence doit rester DISTINGUABLE d'un résumé vide, parce que l'écran ne dit
   * pas la même chose dans les deux cas. Les analyses d'avant la migration 0100 n'en ont pas.
   */
  summary: z.string().trim().max(800).optional(),
  /**
   * Le CLIENT a-t-il été injurieux ou agressif envers l'entreprise ?
   *
   * `.default(false)` volontaire : le champ est arrivé après coup, et un modèle qui l'omet ne doit pas
   * invalider toute l'analyse. Une analyse perdue coûte plus cher qu'un signalement manqué.
   *
   * ⚠️ Ce n'est qu'un CONSTAT : il alimente une liste à relire, il ne bloque jamais personne tout seul.
   * Bloquer un client reste une décision humaine, prise depuis l'écran.
   */
  abusive: z.boolean().default(false),
  /**
   * Où en est le client (0 = très mécontent, 10 = très satisfait) et à quel point ça presse (0 = aucune
   * attente particulière, 10 = il attend une réponse immédiate). Migration 0121, lot F du 2026-09-08.
   *
   * 🔴 `undefined` VEUT DIRE « PAS DE MESURE », ET JAMAIS `0`. La colonne est nullable pour la même raison :
   * les analyses d'avant la migration n'en ont pas, et les compter comme zéro rangerait tout l'historique
   * dans le coin « client furieux, urgence nulle ». Le nuage de points ignore ces lignes et dit combien.
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
