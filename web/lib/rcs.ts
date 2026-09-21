import type { RcsOutbound, RcsSuggestion } from './rcs-types';
import { boutonPret } from './rcs-boutons';

/**
 * Forme d'ÉDITION d'un message RCS, partagée par la bibliothèque (Contenu > Messages RCS), l'assistant de
 * campagne et le bloc de scénario.
 *
 * Un seul brouillon pour trois écrans, et c'est le point : le modèle envoyé a deux formes (TEXTE, ou CARTE
 * dès qu'il y a un visuel), et laisser chaque écran refaire cette bascule à sa façon, c'est se garantir trois
 * comportements différents pour la même saisie.
 *
 * Le CARROUSEL (plusieurs cartes défilantes) reste hors de cette forme : il a SON composeur depuis le
 * 2026-09-21 (`web/lib/rcs-carrousel.ts`), parce que trois champs ne savent pas porter plusieurs cartes. Ce
 * composeur-ci le rend `null` (`versBrouillonRcs`) plutôt que de l'ouvrir à moitié et de l'écraser.
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
 * Message stocké -> brouillon. `null` = format que CE composeur ne sait pas éditer : un carrousel (il a le
 * sien, `versBrouillonCarrousel`), ou une carte à titre (aucun composeur n'expose de champ titre sur une carte
 * simple). Le signaler vaut mieux que l'ouvrir à moitié et réenregistrer un message amputé.
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

/**
 * CE QUI MANQUE POUR ENREGISTRER UN MESSAGE SIMPLE, en paires `[fr, en]`.
 *
 * 🔴 LE BOUTON « CRÉER LE MESSAGE » EST GRISÉ SI ET SEULEMENT SI CETTE LISTE N'EST PAS VIDE. Il se grisait
 * jusqu'au 2026-09-21 sur ces quatre conditions sans en nommer aucune ; l'écran des templates WhatsApp, dont
 * celui-ci reprend le dessin, dit ce qu'il attend. Une seule fonction décide des deux, sans quoi le bouton se
 * grise pour une raison que la liste ne nomme pas.
 *
 * Paires `[fr, en]` parce que ce module est pur : `useT()` y est inappelable (convention de `LIBELLE_KIND`).
 */
export function manquesMessageRcs(nom: string, b: BrouillonRcs): Array<[string, string]> {
  const manques: Array<[string, string]> = [];
  if (nom.trim() === '') manques.push(['le nom du message', 'the message name']);
  if (b.text.trim() === '') manques.push(['le texte du message', 'the message text']);
  const max = maxTexteRcs(b.imageUrl);
  if (b.text.length > max) {
    manques.push([`un texte plus court (${max} caractères au plus)`, `a shorter text (${max} characters max)`]);
  }
  if (!b.suggestions.every(boutonPret)) {
    manques.push(['un bouton complet (libellé, lien, numéro ou dates)', 'a complete button (label, link, number or dates)']);
  }
  return manques;
}

/** Le FORMAT d'un message de la bibliothèque, pour la colonne « Format » du tableau, en paire `[fr, en]`. */
export function libelleFormatRcs(content: RcsOutbound | null): [string, string] {
  if (!content) return ['illisible', 'unreadable'];
  if (content.kind === 'text') return ['message', 'message'];
  if (content.kind === 'card') return ['carte', 'card'];
  const n = content.cards.length;
  return [`carrousel · ${n} cartes`, `carousel · ${n} cards`];
}

/**
 * Le début du texte d'un message, pour la colonne « Texte » du tableau. Même lecture que l'aperçu du fil côté
 * serveur (`apercuRcsSortant`) : une carte n'a pas de `text`, un carrousel se lit par sa première carte.
 */
export function extraitRcs(content: RcsOutbound | null): string {
  if (!content) return '';
  if (content.kind === 'text') return content.text;
  if (content.kind === 'card') return content.card.description ?? content.card.title ?? '';
  const premiere = content.cards[0];
  return premiere?.description ?? premiere?.title ?? '';
}
