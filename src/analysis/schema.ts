import { z } from 'zod';

export const SENTIMENTS = ['positif', 'neutre', 'negatif'] as const;
export const INTENTS = ['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'autre'] as const;
export const ACTIONS = ['creer_devis', 'rappeler', 'relancer', 'escalader', 'aucune'] as const;
export const HANDLED_BY = ['humain', 'automatise', 'mba'] as const;
export type HandledBy = (typeof HANDLED_BY)[number];

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
});
export type LlmOutput = z.infer<typeof llmOutputSchema>;

/** Analyse complète stockée = sortie LLM + faits déterministes. */
export interface ConversationAnalysis extends LlmOutput {
  handled_by: HandledBy;
  exchanges_count: number;
}
