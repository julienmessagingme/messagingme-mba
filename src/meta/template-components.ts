/**
 * Construit le tableau `components` d'un envoi de template (header média, variables du corps, cartes de
 * carousel), au format attendu par l'API Cloud. Extrait pour être testable (l'ancien inline dans index.ts
 * codait le header en dur en `image`, cassant les headers VIDEO/DOCUMENT). SEUL constructeur de composants
 * d'envoi du projet : le chemin campagne et le chemin scénario passent tous les deux par ici (il en existait
 * un second dans campaign/guardrails.ts, c'est ce doublon qui a laissé le carousel non branché côté campagne).
 */

/**
 * Une carte de carousel telle que RELUE dans le template (GET message_templates?fields=components), prête
 * pour l'envoi. Les cartes ne sont jamais saisies : elles viennent du template approuvé.
 */
export interface OutboundCarouselCard {
  /**
   * `media id` Meta du visuel de la carte, obtenu en RE-TÉLÉVERSANT l'image sur le numéro d'envoi.
   * C'est LUI qu'on envoie, pas l'URL : Meta refuse de télécharger ses propres URL de CDN au moment de livrer
   * (403 sur `example.header_handle[0]`, échec asynchrone 131053). Absent = carte non envoyable.
   */
  mediaId?: string;
  /** URL du visuel telle que lue chez Meta. Sert à OBTENIR le `mediaId`, jamais à l'envoi. */
  mediaUrl?: string;
  /** Format du média de la carte (défaut IMAGE). */
  mediaFormat?: 'IMAGE' | 'VIDEO';
  /** Corps de la carte TEL QUE DÉFINI dans le template : sert à détecter une variable non résolvable. */
  body?: string;
  /** Boutons de la carte, dans l'ordre du template. Seul `type` sert à l'envoi ; `text`/`url` sont relus pour
   *  que l'aperçu du template puisse les afficher (le libellé vient du template, jamais de l'opérateur). */
  buttons?: Array<{ type: 'QUICK_REPLY' | 'URL' | 'FLOW'; text?: string; url?: string }>;
}

export interface OutboundTemplateParts {
  bodyParams: string[];
  /**
   * `media id` du visuel d'en-tête, obtenu en le RE-TÉLÉVERSANT sur le numéro d'envoi. Prioritaire sur
   * `headerMediaUrl` : c'est le seul des deux que Meta livre vraiment quand l'URL vient de son propre CDN
   * (cf. `OutboundCarouselCard.mediaId`, même mesure, même piège 131053).
   */
  headerMediaId?: string;
  /** URL publique du média de header, si le template a un header média. */
  headerMediaUrl?: string;
  /** Format du header média (défaut IMAGE si absent mais URL fournie). */
  headerFormat?: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  /** Cartes du composant CAROUSEL du template. Absent = template sans carousel (sortie inchangée). */
  carousel?: { cards: OutboundCarouselCard[] };
}

const HAS_VAR = /\{\{\s*\d+\s*\}\}/;

/**
 * Identifiant d'un bouton de carte : c'est À LA FOIS le `payload` envoyé à Meta et le nom de la sortie du
 * bloc dans le builder. Les deux DOIVENT être la même chaîne, sinon un tap ne retrouve pas sa branche.
 * `buttonIndex` est la position dans TOUS les boutons de la carte (les boutons URL comptent), pas parmi les
 * seules réponses rapides.
 *
 * ⚠️ Dupliqué dans `web/lib/carousel-handle.ts` (les deux builds ne partagent aucun module) et verrouillé par
 * `tests/web-carousel-handle-parity.test.ts`.
 */
export function carouselButtonHandle(cardIndex: number, buttonIndex: number): string {
  return `card:${cardIndex}:btn:${buttonIndex}`;
}

/**
 * Pourquoi ce carousel n'est PAS envoyable en l'état, ou null si tout est bon. À appeler AVANT l'envoi :
 * on refuse avec une raison lisible plutôt que de laisser Meta répondre 132012 à chaque destinataire.
 *
 * Les variables de corps de carte ne sont pas supportées : il n'existe aucun endroit où stocker le mapping
 * « variable de la carte N -> champ CRM » (template_param_hints n'a pas de notion de carte). On refuse au
 * lieu de deviner une valeur.
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
 * Pourquoi l'EN-TÊTE MÉDIA de ce template n'est PAS envoyable, ou null si tout est bon. Même doctrine que
 * `carouselSendBlocker`, et volontairement une fonction SÉPARÉE : y greffer l'en-tête rendrait ses messages
 * faux dans les deux sens (un carousel n'a pas d'en-tête top-level, et un template à en-tête n'a pas de carte).
 *
 * Un template dont Meta a approuvé un en-tête média EXIGE ce média à chaque envoi ; l'image déposée à la
 * création ne sert qu'à la validation. Sans elle, Meta refuse TOUS les destinataires en 132012. On refuse donc
 * avant d'envoyer, avec une raison lisible, plutôt que de collectionner les échecs un par un.
 */
export function headerMediaSendBlocker(headerFormat: string | undefined, mediaId: string | undefined): string | null {
  const media = headerFormat === 'IMAGE' || headerFormat === 'VIDEO' || headerFormat === 'DOCUMENT';
  if (!media) return null; // en-tête texte, ou pas d'en-tête : rien à préparer
  if (mediaId) return null;
  const quoi = headerFormat === 'VIDEO' ? 'la vidéo' : headerFormat === 'DOCUMENT' ? 'le document' : 'l’image';
  return `${quoi} d’en-tête du template n’a pas pu être préparée pour l’envoi`;
}

/**
 * Composants d'UNE carte : le média (que Meta exige à chaque envoi, il n'est jamais dans le template) puis
 * un composant par bouton quick-reply. Pas de composant `body` : la carte n'a pas de variable (garanti par
 * carouselSendBlocker) et un `parameters: []` vide est précisément ce qui déclenche 132012.
 * URL / FLOW statiques -> aucun composant (même règle que les boutons top-level).
 */
function cardComponents(card: OutboundCarouselCard, cardIndex: number): unknown[] {
  const key = card.mediaFormat === 'VIDEO' ? 'video' : 'image';
  // `id` et NON `link` : cf. OutboundCarouselCard.mediaId.
  const out: unknown[] = [{ type: 'header', parameters: [{ type: key, [key]: { id: card.mediaId } }] }];
  (card.buttons ?? []).forEach((b, i) => {
    if (b.type !== 'QUICK_REPLY') return;
    // Payload portant la carte ET le bouton. Un `btn:<i>` nu serait pire qu'ambigu : chaque carte a un bouton
    // d'index 0, donc 10 cartes suivraient TOUTES la branche `btn:0` d'un scénario, présentée comme juste.
    // Aucune branche ne matche `card:i:btn:j` : le run suit son arête par défaut (comme une réponse texte).
    out.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: carouselButtonHandle(cardIndex, i) }] });
  });
  return out;
}

export function buildTemplateComponents(tpl: OutboundTemplateParts): unknown[] {
  const components: unknown[] = [];
  // Un carousel porte ses médias PAR CARTE : le header top-level ne s'applique pas (même règle qu'à la
  // création, cf. meta/templates.ts buildComponents).
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
  return components;
}
