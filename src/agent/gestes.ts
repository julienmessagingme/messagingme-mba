import { z } from 'zod';

/**
 * Les gestes d'un moment : ce que nous faisons nous-mêmes, sans le demander au modèle.
 *
 * Le moment porte une réponse principale, que le modèle appelle, et des gestes déterministes (tag, champ) :
 * le modèle ne voit qu'un outil par situation. Un geste marque que la situation s'est produite, pas que
 * l'appel a réussi. D'où un libellé par défaut « rendez-vous demandé », jamais « rendez-vous pris » : le
 * second poserait dans le mini-CRM une vérité fausse, sur laquelle une automation partirait.
 */

/** Le tag posé sur le contact. Même alphabet que les tags du mini-CRM, bornés par leur propre route. */
const gesteTagSchema = z.object({
  type: z.literal('tag'),
  valeur: z.string().trim().min(1).max(60),
});

/**
 * Une valeur écrite dans un champ du contact. `champ` est une clé du jsonb `contacts.fields`, nommée par le
 * client sans convention (« mail » ici, « email » là) : on ne valide que la forme, jamais l'existence.
 */
const gesteVariableSchema = z.object({
  type: z.literal('variable'),
  champ: z.string().trim().min(1).max(64),
  valeur: z.string().trim().max(500),
});

export const gesteSchema = z.discriminatedUnion('type', [gesteTagSchema, gesteVariableSchema]);

/**
 * Plafond de gestes par moment. Pas une limite technique : au-delà, un moment devient un mini-scénario, et
 * les scénarios existent déjà pour ça.
 */
export const MAX_GESTES = 4;

export const gestesSchema = z.array(gesteSchema).max(MAX_GESTES);

export type Geste = z.infer<typeof gesteSchema>;

/**
 * Relit les gestes stockés en jsonb. Illisible : aucun geste, jamais une exception, sinon une ligne mal
 * écrite rendrait l'agent muet sur chaque message.
 */
export function lireGestes(brut: unknown): Geste[] {
  const r = gestesSchema.safeParse(brut ?? []);
  return r.success ? r.data : [];
}
