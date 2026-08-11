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
  /** URL publique du média de la carte. Absente = carte non envoyable (cf. carouselSendBlocker). */
  mediaUrl?: string;
  /** Format du média de la carte (défaut IMAGE). */
  mediaFormat?: 'IMAGE' | 'VIDEO';
  /** Corps de la carte TEL QUE DÉFINI dans le template : sert à détecter une variable non résolvable. */
  body?: string;
  /** Boutons de la carte, dans l'ordre du template. */
  buttons?: Array<{ type: 'QUICK_REPLY' | 'URL' | 'FLOW' }>;
}

export interface OutboundTemplateParts {
  bodyParams: string[];
  /** URL publique du média de header, si le template a un header média. */
  headerMediaUrl?: string;
  /** Format du header média (défaut IMAGE si absent mais URL fournie). */
  headerFormat?: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  /** Cartes du composant CAROUSEL du template. Absent = template sans carousel (sortie inchangée). */
  carousel?: { cards: OutboundCarouselCard[] };
}

const HAS_VAR = /\{\{\s*\d+\s*\}\}/;

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
  const noMedia = cards.findIndex((c) => !c.mediaUrl);
  if (noMedia >= 0) return `l'image de la carte ${noMedia + 1} n'est pas récupérable depuis Meta`;
  const withVar = cards.findIndex((c) => HAS_VAR.test(c.body ?? ''));
  if (withVar >= 0) return `la carte ${withVar + 1} contient une variable, non supporté à l'envoi`;
  return null;
}

/**
 * Composants d'UNE carte : le média (que Meta exige à chaque envoi, il n'est jamais dans le template) puis
 * un composant par bouton quick-reply. Pas de composant `body` : la carte n'a pas de variable (garanti par
 * carouselSendBlocker) et un `parameters: []` vide est précisément ce qui déclenche 132012.
 * URL / FLOW statiques -> aucun composant (même règle que les boutons top-level).
 */
function cardComponents(card: OutboundCarouselCard, cardIndex: number): unknown[] {
  const key = card.mediaFormat === 'VIDEO' ? 'video' : 'image';
  const out: unknown[] = [{ type: 'header', parameters: [{ type: key, [key]: { link: card.mediaUrl } }] }];
  (card.buttons ?? []).forEach((b, i) => {
    if (b.type !== 'QUICK_REPLY') return;
    // Payload portant la carte ET le bouton. Un `btn:<i>` nu serait pire qu'ambigu : chaque carte a un bouton
    // d'index 0, donc 10 cartes suivraient TOUTES la branche `btn:0` d'un scénario, présentée comme juste.
    // Aucune branche ne matche `card:i:btn:j` : le run suit son arête par défaut (comme une réponse texte).
    out.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: `card:${cardIndex}:btn:${i}` }] });
  });
  return out;
}

export function buildTemplateComponents(tpl: OutboundTemplateParts): unknown[] {
  const components: unknown[] = [];
  // Un carousel porte ses médias PAR CARTE : le header top-level ne s'applique pas (même règle qu'à la
  // création, cf. meta/templates.ts buildComponents).
  if (tpl.headerMediaUrl && !tpl.carousel) {
    const key = tpl.headerFormat === 'VIDEO' ? 'video' : tpl.headerFormat === 'DOCUMENT' ? 'document' : 'image';
    components.push({ type: 'header', parameters: [{ type: key, [key]: { link: tpl.headerMediaUrl } }] });
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
