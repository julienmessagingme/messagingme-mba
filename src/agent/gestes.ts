import { z } from 'zod';

/**
 * LES GESTES D'UN MOMENT : ce que NOUS faisons, sans le demander au modèle (passe 2 du lot 2, 2026-09-18).
 *
 * 🔴 CE QU'ILS RÉPARENT, ET C'EST JULIEN QUI A POSÉ LE CAS. « Quand le client veut un rendez-vous », il veut
 * appeler son ERP ET poser un tag. Aujourd'hui les deux sont des OUTILS, donc deux surfaces exposées au
 * modèle qui décrivent la MÊME situation : il en choisit une, ou les deux, ou aucune, et le résultat dépend
 * de son humeur. Le moment porte donc UNE réponse principale, que le modèle appelle, et des GESTES que nous
 * exécutons nous-mêmes. Le modèle ne voit qu'un outil par situation, et les effets de bord deviennent
 * déterministes.
 *
 * 🔴 ILS SONT INDÉPENDANTS DE LA RÉUSSITE DE LA RÉPONSE, arbitrage de Julien du 2026-09-18 : un geste marque
 * que la SITUATION s'est produite, pas que l'appel a réussi. Le contact a bien demandé un rendez-vous même
 * si l'ERP n'a pas répondu, et c'est précisément ce tag-là qui permet de rattraper à la main.
 *
 * ⚠️ CONSÉQUENCE SUR LES MOTS, ET ELLE N'EST PAS COSMÉTIQUE : un libellé par défaut doit dire
 * « rendez-vous demandé », JAMAIS « rendez-vous pris ». Le second serait une vérité fausse posée dans le
 * mini-CRM, sur laquelle une automation partirait ensuite.
 */

/** Le TAG posé sur le contact. Même alphabet que les tags du mini-CRM, bornés par leur propre route. */
const gesteTagSchema = z.object({
  type: z.literal('tag'),
  valeur: z.string().trim().min(1).max(60),
});

/**
 * Une VALEUR écrite dans un champ du contact.
 *
 * ⚠️ `champ` est une CLÉ DU JSONB `contacts.fields`, que le client nomme lui-même : il n'y a aucune
 * convention de nom dans ce dépôt, qui porte la trace d'un espace disant « mail » quand un autre disait
 * « email ». On ne valide donc que la FORME, jamais l'existence.
 */
const gesteVariableSchema = z.object({
  type: z.literal('variable'),
  champ: z.string().trim().min(1).max(64),
  valeur: z.string().trim().max(500),
});

export const gesteSchema = z.discriminatedUnion('type', [gesteTagSchema, gesteVariableSchema]);

/**
 * Plafond de gestes par moment.
 *
 * ⚠️ Quatre, et ce n'est pas une limite technique : au-delà, un moment cesse d'être « quand X, fais Y » pour
 * devenir un mini-scénario, alors que les scénarios existent déjà pour ça. C'est exactement la raison pour
 * laquelle la liste ordonnée d'actions a été écartée au cadrage.
 */
export const MAX_GESTES = 4;

export const gestesSchema = z.array(gesteSchema).max(MAX_GESTES);

export type Geste = z.infer<typeof gesteSchema>;

/**
 * Relit les gestes stockés en jsonb. Illisible -> AUCUN geste, jamais une exception.
 *
 * 🔴 `safeParse` ET REPLI VIDE, comme partout où ce dépôt relit un jsonb écrit par un tour antérieur. Un
 * geste corrompu ne doit pas faire échouer un tour d'agent : il doit ne rien produire. L'inverse ferait
 * qu'une ligne mal écrite un jour rendrait l'agent muet pour toujours, sur le chemin de chaque message.
 */
export function lireGestes(brut: unknown): Geste[] {
  const r = gestesSchema.safeParse(brut ?? []);
  return r.success ? r.data : [];
}
