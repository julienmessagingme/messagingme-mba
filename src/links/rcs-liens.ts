import { isSendableButtonUrl } from '../meta/button-url';
import type { RcsOutbound, RcsCard, RcsSuggestion } from '../rcs/types';

/**
 * Traçage des liens d'un message RCS. Tout est PUR ici : repérer les adresses traçables, et rendre une COPIE
 * du message dont les boutons `openUrl` pointent la redirection. L'allocation des codes et l'écriture en base
 * restent à l'appelant, ce qui rend la règle vérifiable sans base ni réseau.
 *
 * 🔴 CE QUI CHANGE TOUT PAR RAPPORT À WHATSAPP. Un template est soumis puis FIGÉ : son lien doit être réservé
 * AVANT la soumission, et l'URL soumise porte un `{{1}}` que chaque envoi doit remplir. Un message RCS n'est
 * soumis à personne : il est composé À L'ENVOI. On y écrit donc le jeton du destinataire directement, sans
 * variable, sans resoumission, et sans le risque de 132000 qui rend l'envoi WhatsApp « tout ou rien ».
 *
 * Conséquence heureuse : le message STOCKÉ (bibliothèque, campagne, graphe de scénario) garde l'adresse saisie
 * par l'utilisateur, toujours. Il n'y a donc RIEN à ré-habiller à l'affichage, contrairement aux templates.
 *
 * La maille est l'ADRESSE, pas le bouton : deux boutons vers la même page partagent un code. C'est cohérent
 * avec la clé retenue en base (migration 0107) et avec ce qu'un opérateur veut lire (« combien de clics vers
 * cette page »), pas avec une position dans un tableau de boutons qui n'a de sens que chez Meta.
 */

/**
 * Au-delà de cette longueur, une adresse n'est PAS tracée : elle part telle quelle, non mesurée.
 *
 * Deux raisons, et la première suffit : la clé d'unicité de la 0107 porte sur `destination`, et un index btree
 * refuse une valeur démesurée, ce qui ferait échouer l'allocation donc l'envoi. Un lien non mesuré est un
 * défaut de mesure ; un message qui ne part pas est un défaut de produit. Le seuil est large : Meta plafonne
 * ses propres URL de bouton à 2000 caractères, et une adresse de mille caractères est déjà une anomalie.
 */
export const URL_TRACABLE_MAX = 1000;

/** L'adresse d'un bouton est-elle traçable ? Fonction PURE, c'est la seule règle d'admission. */
export function estTracable(url: string): boolean {
  const u = url.trim();
  if (u === '' || u.length > URL_TRACABLE_MAX) return false;
  // Une URL qui porte une variable n'est JAMAIS substituée en RCS (`src/rcs/variables.ts` : « PAS les URL »,
  // une variable vide fabriquerait une adresse invalide donc un message refusé). La tracer figerait cette
  // adresse cassée derrière un code, et le clic mènerait à une page qui n'existe pas.
  if (u.includes('{{')) return false;
  return isSendableButtonUrl(u);
}

/** Toutes les suggestions du message, tous niveaux confondus, dans l'ordre où elles s'affichent. */
function toutesLesSuggestions(msg: RcsOutbound): RcsSuggestion[] {
  if (msg.kind === 'carousel') return msg.cards.flatMap((c) => c.suggestions ?? []);
  const dansLaCarte = msg.kind === 'card' ? msg.card.suggestions ?? [] : [];
  return [...dansLaCarte, ...(msg.suggestions ?? [])];
}

/**
 * Les adresses traçables de ce message, SANS DOUBLON et dans l'ordre de première apparition.
 *
 * Sans doublon parce que la maille est l'adresse : un message qui répète le même lien dans sa carte et dans
 * ses pastilles ne doit provoquer qu'une allocation, pas deux.
 */
export function destinationsTracables(msg: RcsOutbound): string[] {
  const vues: string[] = [];
  for (const s of toutesLesSuggestions(msg)) {
    if (s.kind !== 'openUrl') continue;
    const u = s.url.trim();
    if (!estTracable(u) || vues.includes(u)) continue;
    vues.push(u);
  }
  return vues;
}

/** Ce message porte-t-il au moins un lien traçable ? Sert à N'ALLER CHERCHER un jeton que si c'est utile. */
export function aDesLiensTracables(msg: RcsOutbound): boolean {
  return destinationsTracables(msg).length > 0;
}

/**
 * Rend une COPIE du message dont les boutons `openUrl` listés dans `liens` portent l'adresse de redirection.
 *
 * Une COPIE, et la même référence quand il n'y a rien à changer : l'appelant (le point d'envoi unique) chaîne
 * plusieurs mises en forme et teste l'identité pour savoir si le message a bougé.
 *
 * Une adresse absente de la table sort INCHANGÉE : c'est le comportement voulu quand l'allocation d'un code a
 * échoué. Le bouton mène alors à la bonne page sans être mesuré, ce qui vaut infiniment mieux qu'un message
 * amputé de son bouton, ou pas envoyé du tout.
 */
export function appliquerLiensRcs(msg: RcsOutbound, liens: ReadonlyMap<string, string>): RcsOutbound {
  if (liens.size === 0) return msg;

  let touche = false;
  const remplacer = (suggestions: RcsSuggestion[] | undefined): RcsSuggestion[] | undefined => {
    if (!suggestions?.length) return suggestions;
    return suggestions.map((s) => {
      if (s.kind !== 'openUrl') return s;
      const lien = liens.get(s.url.trim());
      if (!lien) return s;
      touche = true;
      return { ...s, url: lien };
    });
  };

  if (msg.kind === 'carousel') {
    const cards: RcsCard[] = msg.cards.map((c) => {
      const suggestions = remplacer(c.suggestions);
      return suggestions === c.suggestions ? c : { ...c, suggestions };
    });
    return touche ? { ...msg, cards } : msg;
  }

  const enPastilles = remplacer(msg.suggestions);
  if (msg.kind === 'card') {
    const dansLaCarte = remplacer(msg.card.suggestions);
    if (!touche) return msg;
    return {
      ...msg,
      card: dansLaCarte === msg.card.suggestions ? msg.card : { ...msg.card, suggestions: dansLaCarte },
      ...(enPastilles ? { suggestions: enPastilles } : {}),
    };
  }
  if (!touche) return msg;
  return { ...msg, ...(enPastilles ? { suggestions: enPastilles } : {}) };
}
