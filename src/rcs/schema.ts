import { z } from 'zod';
import type { RcsOutbound, RcsSuggestion } from './types';

/**
 * Validation d'un message RCS reçu du client (assistant de campagne, bloc de scénario, bibliothèque), en une
 * seule définition. Les bornes sont celles de l'API smsmode (un libellé de bouton : 25 caractères) : un
 * dépassement fait refuser l'envoi entier, mieux vaut le refuser à la saisie. Union fermée : un `kind`
 * inconnu ne traverse jamais jusqu'au provider ; toujours `safeParse` chez l'appelant.
 */
/** Longueur maximale d'un message RCS texte, exportée pour que la route d'envoi de l'Inbox borne la réponse
 *  libre avec la même valeur. */
export const RCS_TEXTE_MAX = 3072;

const libelle = z.string().min(1).max(25);
const postback = z.string().min(1);

/**
 * Une date-heure de bouton Agenda : une date ISO locale (`2026-09-01T10:00:00`, sans fuseau) ou une variable
 * `{{champ}}` résolue par contact à l'envoi. `elaguerBoutonsInvalides` retire à l'envoi le bouton dont la
 * valeur résolue n'est pas une date.
 */
export const DATE_BOUTON_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const dateBouton = z.string().min(1).refine(
  (v) => DATE_BOUTON_RE.test(v) || /\{\{\s*[\w.-]+\s*\}\}/.test(v),
  { message: 'date au format 2026-09-01T10:00:00, ou variable {{champ}}' },
);

export const rcsSuggestionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), text: libelle, postbackData: postback }),
  z.object({ kind: z.literal('openUrl'), text: libelle, url: z.string().url(), postbackData: postback }),
  z.object({ kind: z.literal('dial'), text: libelle, phoneNumber: z.string().min(1), postbackData: postback }),
  z.object({
    kind: z.literal('calendar'), text: libelle, postbackData: postback,
    title: z.string().min(1).max(100), description: z.string().max(500).optional(),
    startAt: dateBouton, endAt: dateBouton,
  }),
  z.object({
    kind: z.literal('showLocation'), text: libelle, postbackData: postback,
    latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
    label: z.string().max(100).optional(),
  }),
  z.object({ kind: z.literal('requestLocation'), text: libelle, postbackData: postback }),
]);

/**
 * Carte : le format à visuel, qui porte l'image d'en-tête. `title` est optionnel, mais l'API exige « un titre
 * ou un média » : le refine tient cette règle. `description` est plafonnée à 2000 (3072 pour un texte) : la
 * borne de leur champ.
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
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(RCS_TEXTE_MAX), suggestions: z.array(rcsSuggestionSchema).max(11).optional() }),
  // Les boutons d'une carte existent à deux niveaux, et c'est ce qui décide de leur apparence : dans la carte
  // (4 au plus), boutons pleine largeur qui restent ; sous le message (11 au plus), pastilles qui disparaissent
  // dès que la conversation avance.
  z.object({ kind: z.literal('card'), card: rcsCardSchema, suggestions: z.array(rcsSuggestionSchema).max(11).optional() }),
  z.object({ kind: z.literal('carousel'), cards: z.array(rcsCardSchema).min(2).max(10) }),
]);

/** Message relu de notre base (jsonb déjà validé à l'écriture). Rendu `null` si la forme est inattendue,
 *  plutôt qu'un `as` qui laisserait passer n'importe quoi jusqu'au provider. */
export function parseStoredRcsOutbound(raw: unknown): RcsOutbound | null {
  const r = rcsOutboundSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * Ce qui s'affiche dans le fil d'inbox pour un message RCS sortant : une carte n'a pas de `text`, sa bulle
 * serait vide sans cette mise en forme.
 */
export function apercuRcsSortant(msg: RcsOutbound): string {
  if (msg.kind === 'text') return msg.text;
  if (msg.kind === 'card') return msg.card.description ?? msg.card.title ?? '[carte]';
  return msg.cards[0]?.description ?? msg.cards[0]?.title ?? '[carrousel]';
}

/**
 * Réécrit le `postbackData` des boutons réponse en `btn:<i>`, i étant l'index parmi les seules réponses.
 *
 * C'est ce qui relie un clic à une branche : le builder nomme les sorties d'un bloc RCS `btn:0`, `btn:1`… en
 * ne comptant que les boutons réponse, smsmode renvoie le `postbackData` tel qu'envoyé, et l'exécuteur
 * cherche l'arête qui porte ce nom. Sans correspondance, le clic tombe dans le vide et le parcours s'arrête
 * en silence. Appliqué à l'envoi : les messages déjà en bibliothèque se réparent seuls.
 */
export function normaliserPostbacks(msg: RcsOutbound): RcsOutbound {
  if (msg.kind === 'carousel') return msg;
  // Ordre : les boutons de la carte d'abord, les pastilles ensuite, comme l'écran les écrit et le builder
  // numérote les sorties. L'autre sens enverrait un clic sur la branche d'un autre bouton.
  let rang = 0;
  const reecrire = (suggestions: RcsSuggestion[] | undefined): RcsSuggestion[] | undefined => {
    if (!suggestions?.length) return suggestions;
    return suggestions.map((s) => (s.kind === 'reply' ? { ...s, postbackData: `btn:${rang++}` } : s));
  };
  if (msg.kind === 'card') {
    const dansLaCarte = reecrire(msg.card.suggestions);
    const enPastilles = reecrire(msg.suggestions);
    if (dansLaCarte === msg.card.suggestions && enPastilles === msg.suggestions) return msg;
    return {
      ...msg,
      card: dansLaCarte ? { ...msg.card, suggestions: dansLaCarte } : msg.card,
      ...(enPastilles ? { suggestions: enPastilles } : {}),
    };
  }
  const reecrites = reecrire(msg.suggestions);
  return reecrites ? { ...msg, suggestions: reecrites } : msg;
}
