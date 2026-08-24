import type { RcsOutbound, RcsSuggestion } from './rcs-types';

/**
 * Forme d'ÉDITION d'un message RCS, partagée par la bibliothèque (Contenu > Messages RCS), l'assistant de
 * campagne et le bloc de scénario.
 *
 * Un seul brouillon pour trois écrans, et c'est le point : le modèle envoyé a deux formes (TEXTE, ou CARTE
 * dès qu'il y a un visuel), et laisser chaque écran refaire cette bascule à sa façon, c'est se garantir trois
 * comportements différents pour la même saisie.
 *
 * Le CARROUSEL (plusieurs cartes défilantes) reste hors de cette forme : il n'a pas de composeur et n'en aura
 * un que si un besoin réel le demande. Un message de ce format est signalé comme non éditable, jamais
 * silencieusement écrasé.
 */
export interface BrouillonRcs {
  text: string;
  /** URL du visuel d'en-tête. Vide = message texte. Renseignée = message CARTE, image au-dessus du texte. */
  imageUrl: string;
  suggestions: RcsSuggestion[];
}

export const MAX_BOUTONS_RCS = 11;
/** Bornes de l'API smsmode. Un texte de carte est plus court qu'un texte nu : c'est leur champ, pas un choix. */
export const MAX_TEXTE_RCS = 3072;
export const MAX_TEXTE_RCS_AVEC_IMAGE = 2000;

/** Plafond applicable au texte selon qu'il y a un visuel ou non. */
export function maxTexteRcs(imageUrl: string): number {
  return imageUrl.trim() === '' ? MAX_TEXTE_RCS : MAX_TEXTE_RCS_AVEC_IMAGE;
}

/**
 * Brouillon -> message envoyable.
 *
 * `postbackData` est dérivé du libellé quand il est vide, pour rester lisible dans un graphe ; il est de
 * toute façon RÉÉCRIT en `btn:<i>` à l'envoi côté serveur, seul nom que sait retrouver une sortie de bloc.
 *
 * Avec une image : le texte devient la DESCRIPTION d'une carte, et les boutons restent au niveau du message
 * (11 possibles, contre 4 s'ils étaient dans la carte).
 */
export function versMessageRcs(b: BrouillonRcs): RcsOutbound {
  const suggestions = b.suggestions
    .filter((s) => s.text.trim() !== '')
    .map((s, i) => ({ ...s, text: s.text.trim(), postbackData: s.postbackData.trim() || `btn_${i + 1}` }));
  const boutons = suggestions.length ? { suggestions } : {};
  const image = b.imageUrl.trim();
  if (image !== '') {
    return {
      kind: 'card',
      // `mediaHeight: TALL` = le grand visuel 16:9 des campagnes. C'est ce que les gens ont en tête en
      // disant « une image en en-tête » ; le défaut du provider (MEDIUM, 2:1) rogne le visuel.
      card: { description: b.text.trim(), mediaUrl: image, mediaHeight: 'TALL' },
      ...boutons,
    };
  }
  return { kind: 'text', text: b.text.trim(), ...boutons };
}

/**
 * Message stocké -> brouillon. `null` = format que cet écran ne sait pas éditer (carrousel, ou carte à
 * titre : ce composeur n'expose pas de champ titre). Le signaler vaut mieux que l'ouvrir à moitié et
 * réenregistrer un message amputé.
 */
export function versBrouillonRcs(content: RcsOutbound | null): BrouillonRcs | null {
  if (!content) return null;
  if (content.kind === 'text') {
    return { text: content.text, imageUrl: '', suggestions: content.suggestions ?? [] };
  }
  if (content.kind === 'card' && !content.card.title) {
    return {
      text: content.card.description ?? '',
      imageUrl: content.card.mediaUrl ?? '',
      suggestions: content.suggestions ?? [],
    };
  }
  return null;
}

/**
 * Emojis proposés par le sélecteur. Liste COURTE et choisie : ce sont ceux qui servent vraiment dans un
 * message commercial. Un sélecteur complet demanderait une bibliothèque externe et des milliers de
 * caractères pour un usage qui tient en deux rangées ; le clavier du système reste disponible pour le reste.
 */
export const EMOJIS_RCS: readonly string[] = [
  '👋', '😊', '🙂', '😉', '🎉', '🚀', '✨', '🔥',
  '✅', '❌', '⚠️', '👉', '📅', '⏰', '📍', '📞',
  '💬', '📧', '🎁', '💰', '💡', '⭐', '❤️', '🙏',
  '🛒', '📦', '🚗', '🏠', '🍽️', '☀️', '🌙', '🎯',
];
