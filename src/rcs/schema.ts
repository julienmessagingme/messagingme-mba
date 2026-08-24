import { z } from 'zod';
import type { RcsOutbound, RcsSuggestion } from './types';

/**
 * Validation d'un message RCS reçu du client (assistant de campagne, bloc de scénario, bibliothèque).
 *
 * UNE SEULE définition dans le projet : elle vivait dans `http/campaigns.ts` et la bibliothèque en aurait
 * fait un second exemplaire. Deux schémas pour la même donnée finissent toujours par diverger, et c'est
 * exactement ce qui a coûté des bugs de production sur les composants Meta et les visuels de carousel.
 *
 * Les bornes ne sont pas décoratives : elles sont celles de l'API smsmode (spec lue à la source le
 * 2026-08-24). Un dépassement fait refuser l'envoi ENTIER, donc mieux vaut le refuser à la saisie, où
 * quelqu'un peut encore corriger.
 *
 * Union FERMÉE : un `kind` inconnu est refusé, il ne traverse jamais jusqu'au provider. Toujours en
 * `safeParse` chez l'appelant, jamais `parse`.
 */
export const rcsSuggestionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), text: z.string().min(1).max(25), postbackData: z.string().min(1) }),
  z.object({ kind: z.literal('openUrl'), text: z.string().min(1).max(25), url: z.string().url(), postbackData: z.string().min(1) }),
  z.object({ kind: z.literal('dial'), text: z.string().min(1).max(25), phoneNumber: z.string().min(1), postbackData: z.string().min(1) }),
]);

/**
 * Carte : le format à VISUEL. C'est lui qui porte l'image d'en-tête.
 *
 * `title` est optionnel depuis qu'une carte peut n'être qu'une image et un texte (le cas courant d'une
 * campagne : un visuel, un message, des boutons). L'API exige « un titre OU un média » : le refine ci-dessous
 * tient cette règle, sinon la carte partirait vide et se ferait refuser à l'envoi.
 *
 * `description` est plafonnée à 2000 alors qu'un message TEXTE va jusqu'à 3072 : c'est la borne de leur
 * champ, pas un choix de produit. L'écran doit le dire au moment où l'on ajoute une image.
 */
export const rcsCardSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  mediaUrl: z.string().url().max(255).optional(),
  /** Hauteur du visuel. Défaut MEDIUM (2:1) côté provider ; TALL (16:9) donne la grande image de campagne. */
  mediaHeight: z.enum(['SHORT', 'MEDIUM', 'TALL']).optional(),
  suggestions: z.array(rcsSuggestionSchema).max(4).optional(),
}).refine((c) => (c.title !== undefined && c.title !== '') || (c.mediaUrl !== undefined && c.mediaUrl !== ''), {
  message: 'une carte doit porter au moins un titre ou une image',
});

export const rcsOutboundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(3072), suggestions: z.array(rcsSuggestionSchema).max(11).optional() }),
  // Les boutons d'une CARTE existent à deux niveaux chez le provider : dans la carte (4 maximum, collés au
  // visuel) et sous le message (11 maximum, la rangée de pastilles). On garde les deux, et l'écran n'utilise
  // que le second : c'est celui qui laisse 11 choix et qui se relie aux sorties d'un scénario.
  z.object({ kind: z.literal('card'), card: rcsCardSchema, suggestions: z.array(rcsSuggestionSchema).max(11).optional() }),
  z.object({ kind: z.literal('carousel'), cards: z.array(rcsCardSchema).min(2).max(10) }),
]);

/** Message relu de NOTRE base (jsonb déjà validé à l'écriture). Rendu `null` si la forme est inattendue,
 *  plutôt qu'un `as` qui laisserait passer n'importe quoi jusqu'au provider. */
export function parseStoredRcsOutbound(raw: unknown): RcsOutbound | null {
  const r = rcsOutboundSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * Réécrit le `postbackData` des boutons RÉPONSE en `btn:<i>`, i étant l'index du bouton PARMI LES RÉPONSES.
 *
 * 🔴 C'est ce qui relie un clic à une branche de scénario, et ce n'est pas cosmétique. Le builder nomme les
 * sorties d'un bloc RCS `btn:0`, `btn:1`… en ne comptant QUE les boutons réponse (un bouton lien ou appel
 * sort de la conversation et ne revient jamais). Quand le contact tape un bouton, smsmode nous renvoie le
 * `postbackData` tel qu'on l'a envoyé, et l'exécuteur cherche l'arête qui porte ce nom. Si l'envoi portait
 * `btn_1` (ce qu'écrivait la bibliothèque) ou un texte libre, AUCUNE arête ne correspond : le clic tombe
 * dans le vide et le parcours s'arrête, en silence.
 *
 * Appliqué à l'ENVOI et non à l'enregistrement : les messages déjà en bibliothèque se réparent donc seuls,
 * sans migration ni ressaisie.
 */
export function normaliserPostbacks(msg: RcsOutbound): RcsOutbound {
  if (msg.kind === 'carousel') return msg;
  const suggestions = msg.suggestions;
  if (!suggestions?.length) return msg;
  let rang = 0;
  const reecrites: RcsSuggestion[] = suggestions.map((s) => (s.kind === 'reply' ? { ...s, postbackData: `btn:${rang++}` } : s));
  return { ...msg, suggestions: reecrites };
}
