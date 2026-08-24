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
 * Nombre de boutons affichés EN LISTE, dans la carte. Limite du protocole, pas un choix de produit.
 * (Documentation RBM : « Rich cards support up to 4 persistent suggestions », affichées dans la carte.)
 */
export const MAX_BOUTONS_CARTE = 4;

/**
 * Brouillon -> message envoyable.
 *
 * 🔴 OÙ SONT ACCROCHÉS LES BOUTONS DÉCIDE DE LEUR APPARENCE, et ce n'est pas nous qui la dessinons : c'est
 * l'application Messages du destinataire. Vérifié dans la documentation RBM de Google le 2026-08-24 :
 *
 *   - accrochés au MESSAGE, ils s'affichent en petites PASTILLES posées sous la bulle, en ligne, et
 *     disparaissent dès que la conversation avance (jusqu'à 11) ;
 *   - accrochés à la CARTE, ils s'affichent en BOUTONS PLEINE LARGEUR empilés dans la carte, et y restent
 *     (jusqu'à 4).
 *
 * C'est la deuxième forme qu'on reconnaît des grandes campagnes RCS, et la première que produisait cet écran.
 * Dès qu'il y a un visuel, les boutons partent donc DANS la carte. Au-delà de quatre, le surplus retombe en
 * pastilles sous la carte plutôt que d'être perdu (l'écran, lui, plafonne à quatre quand il y a une image).
 *
 * `postbackData` est dérivé du libellé quand il est vide, pour rester lisible dans un graphe ; il est de
 * toute façon RÉÉCRIT en `btn:<i>` à l'envoi côté serveur, seul nom que sait retrouver une sortie de bloc.
 */
export function versMessageRcs(b: BrouillonRcs): RcsOutbound {
  const suggestions = b.suggestions
    .filter((s) => s.text.trim() !== '')
    .map((s, i) => ({ ...s, text: s.text.trim(), postbackData: s.postbackData.trim() || `btn_${i + 1}` }));
  const image = b.imageUrl.trim();

  if (image !== '') {
    const dansLaCarte = suggestions.slice(0, MAX_BOUTONS_CARTE);
    const enPastilles = suggestions.slice(MAX_BOUTONS_CARTE);
    return {
      kind: 'card',
      card: {
        description: b.text.trim(),
        mediaUrl: image,
        // `mediaHeight: TALL` = le grand visuel 16:9 des campagnes. C'est ce que les gens ont en tête en
        // disant « une image en en-tête » ; le défaut du provider (MEDIUM, 2:1) rogne le visuel.
        mediaHeight: 'TALL',
        ...(dansLaCarte.length ? { suggestions: dansLaCarte } : {}),
      },
      ...(enPastilles.length ? { suggestions: enPastilles } : {}),
    };
  }
  return { kind: 'text', text: b.text.trim(), ...(suggestions.length ? { suggestions } : {}) };
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
      // Les boutons de la CARTE d'abord, puis les pastilles : c'est l'ordre dans lequel ils sont écrits, et
      // celui dont dépend la numérotation `btn:<i>` des sorties d'un bloc de scénario.
      suggestions: [...(content.card.suggestions ?? []), ...(content.suggestions ?? [])],
    };
  }
  return null;
}
