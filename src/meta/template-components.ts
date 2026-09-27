/**
 * Construit le tableau `components` d'un envoi de template (header média, variables du corps, cartes de
 * carousel), au format de l'API Cloud. Seul constructeur de composants d'envoi du projet : campagnes et
 * scénarios passent tous par ici.
 */

/**
 * Une carte de carousel relue dans le template (GET message_templates?fields=components), prête pour l'envoi.
 * Les cartes ne sont jamais saisies : elles viennent du template approuvé.
 */
export interface OutboundCarouselCard {
  /**
   * `media id` Meta du visuel, obtenu en re-téléversant l'image sur le numéro d'envoi. C'est lui qu'on envoie, pas
   * l'URL : Meta refuse de télécharger ses propres URL de CDN au moment de livrer (échec asynchrone 131053).
   * Absent = carte non envoyable.
   */
  mediaId?: string;
  /** URL du visuel telle que lue chez Meta : sert à obtenir le `mediaId`, jamais à l'envoi. */
  mediaUrl?: string;
  /** Format du média de la carte (défaut IMAGE). */
  mediaFormat?: 'IMAGE' | 'VIDEO';
  /** Corps de la carte tel que défini dans le template : sert à détecter une variable non résolvable. */
  body?: string;
  /**
   * Boutons de la carte, dans l'ordre du template. Seul `type` sert à l'envoi ; `text` et `url` servent à
   * l'aperçu (le libellé vient du template, jamais de l'opérateur).
   */
  buttons?: Array<{ type: 'QUICK_REPLY' | 'URL' | 'FLOW'; text?: string; url?: string }>;
}

export interface OutboundTemplateParts {
  bodyParams: string[];
  /**
   * `media id` du visuel d'en-tête, re-téléversé sur le numéro d'envoi. Prioritaire sur `headerMediaUrl` : seul
   * des deux que Meta livre quand l'URL vient de son propre CDN (cf. `OutboundCarouselCard.mediaId`).
   */
  headerMediaId?: string;
  /** URL publique du média de header, si le template a un header média. */
  headerMediaUrl?: string;
  /** Format du header média (défaut IMAGE si absent mais URL fournie). */
  headerFormat?: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  /** Cartes du composant CAROUSEL du template. Absent = template sans carousel. */
  carousel?: { cards: OutboundCarouselCard[] };
  /**
   * Le suffixe variable des boutons URL tracés, par index de bouton. Un lien tracé est le même pour tous : le
   * `{{1}}` d'une URL en `.../r/<code>/{{1}}`, rempli à chaque envoi, porte l'identité du destinataire.
   * Absente ou vide = aucun composant de bouton URL : un template approuvé sans suffixe échouerait en 132000.
   */
  suffixesBoutons?: Record<number, string>;
}

const HAS_VAR = /\{\{\s*\d+\s*\}\}/;

/**
 * Identifiant d'un bouton de carte : à la fois le `payload` envoyé à Meta et le nom de la sortie du bloc dans le
 * builder, qui doivent être la même chaîne pour qu'un tap retrouve sa branche. `buttonIndex` compte tous les
 * boutons de la carte (URL compris). Dupliqué dans `web/lib/carousel-handle.ts`, parité tenue par
 * `tests/web-carousel-handle-parity.test.ts`.
 */
export function carouselButtonHandle(cardIndex: number, buttonIndex: number): string {
  return `card:${cardIndex}:btn:${buttonIndex}`;
}

/**
 * Pourquoi ce carousel n'est pas envoyable, ou null. À appeler avant l'envoi : une raison lisible plutôt qu'un
 * 132012 par destinataire. Les variables de corps de carte ne sont pas supportées : rien ne stocke le mapping
 * « variable de la carte N -> champ CRM », et on refuse au lieu de deviner.
 */
export function carouselSendBlocker(cards: OutboundCarouselCard[]): string | null {
  if (cards.length === 0) return 'ce carousel ne contient aucune carte';
  // On teste le `mediaId`, pas l'URL : c'est le seul des deux qui se livre. Une carte dont l'image n'a pas pu
  // être re-téléversée n'est pas envoyable, même si son URL existe.
  const noMedia = cards.findIndex((c) => !c.mediaId);
  if (noMedia >= 0) return `l'image de la carte ${noMedia + 1} n'a pas pu être préparée pour l'envoi`;
  const withVar = cards.findIndex((c) => HAS_VAR.test(c.body ?? ''));
  if (withVar >= 0) return `la carte ${withVar + 1} contient une variable, non supporté à l'envoi`;
  // Même raison pour un bouton dont l'URL porte une variable ({{1}}) : sa valeur se fournit à l'envoi, carte par
  // carte, et rien ne la stocke. Les carousels créés ici ont des URL fixes ; celui-ci vient de Meta directement.
  const withUrlVar = cards.findIndex((c) => (c.buttons ?? []).some((b) => HAS_VAR.test(b.url ?? '')));
  if (withUrlVar >= 0) return `le lien de la carte ${withUrlVar + 1} contient une variable, non supporté à l'envoi`;
  return null;
}

/**
 * Pourquoi l'en-tête média de ce template n'est pas envoyable, ou null. Fonction séparée de
 * `carouselSendBlocker`, dont les messages seraient faux ici. Un en-tête média approuvé exige ce média à chaque
 * envoi (l'image de création ne sert qu'à la validation) : sans lui, Meta refuse tous les destinataires en 132012.
 */
export function headerMediaSendBlocker(headerFormat: string | undefined, mediaId: string | undefined): string | null {
  const media = headerFormat === 'IMAGE' || headerFormat === 'VIDEO' || headerFormat === 'DOCUMENT';
  if (!media) return null; // en-tête texte, ou pas d'en-tête : rien à préparer
  if (mediaId) return null;
  const quoi = headerFormat === 'VIDEO' ? 'la vidéo' : headerFormat === 'DOCUMENT' ? 'le document' : 'l’image';
  return `${quoi} d’en-tête du template n’a pas pu être préparée pour l’envoi`;
}

/**
 * Composants d'une carte : le média (exigé à chaque envoi, jamais dans le template), puis un composant par
 * bouton quick-reply. Pas de composant `body` : un `parameters: []` vide déclenche 132012. Boutons URL et FLOW
 * statiques : aucun composant.
 */
function cardComponents(card: OutboundCarouselCard, cardIndex: number): unknown[] {
  const key = card.mediaFormat === 'VIDEO' ? 'video' : 'image';
  // `id` et non `link` : cf. OutboundCarouselCard.mediaId.
  const out: unknown[] = [{ type: 'header', parameters: [{ type: key, [key]: { id: card.mediaId } }] }];
  (card.buttons ?? []).forEach((b, i) => {
    if (b.type !== 'QUICK_REPLY') return;
    // Le payload porte la carte et le bouton : un `btn:<i>` nu ferait suivre à toutes les cartes la même branche.
    // `card:i:btn:j` sans branche correspondante : le run suit son arête par défaut, comme une réponse texte.
    out.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: carouselButtonHandle(cardIndex, i) }] });
  });
  return out;
}

export function buildTemplateComponents(tpl: OutboundTemplateParts): unknown[] {
  const components: unknown[] = [];
  // Un carousel porte ses médias par carte : le header top-level ne s'applique pas (cf. templates.ts buildComponents).
  if ((tpl.headerMediaId || tpl.headerMediaUrl) && !tpl.carousel) {
    const key = tpl.headerFormat === 'VIDEO' ? 'video' : tpl.headerFormat === 'DOCUMENT' ? 'document' : 'image';
    // `id` dès qu'on l'a, `link` en repli (une URL fournie à la main par un opérateur, elle, se télécharge).
    const media = tpl.headerMediaId ? { id: tpl.headerMediaId } : { link: tpl.headerMediaUrl };
    components.push({ type: 'header', parameters: [{ type: key, [key]: media }] });
  }
  if (tpl.bodyParams.length > 0) {
    components.push({ type: 'body', parameters: tpl.bodyParams.map((v) => ({ type: 'text', text: v })) });
  }
  if (tpl.carousel) {
    components.push({
      type: 'carousel',
      cards: tpl.carousel.cards.map((c, i) => ({ card_index: i, components: cardComponents(c, i) })),
    });
  }
  // Suffixes des boutons URL tracés : `sub_type: 'url'` avec un paramètre texte, que Meta ajoute à la fin de
  // l'URL du bouton. L'index compte tous les boutons du template (numérotation de Meta, celle de `tracked_links`).
  for (const [index, suffixe] of Object.entries(tpl.suffixesBoutons ?? {})) {
    components.push({ type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text: suffixe }] });
  }
  return components;
}
