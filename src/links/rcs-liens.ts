import { isSendableButtonUrl } from '../../web/lib/partage/button-url';
import type { RcsOutbound, RcsCard, RcsSuggestion } from '../rcs/types';

/**
 * Traçage des liens d'un message RCS, en fonctions pures : repérer les adresses traçables et rendre une copie
 * du message dont les boutons `openUrl` pointent la redirection. L'allocation et la base restent à l'appelant.
 *
 * Contrairement à un template WhatsApp (soumis puis figé, d'où un `{{1}}` à remplir), un message RCS est
 * composé à l'envoi : on y écrit le jeton directement, sans variable ni risque de 132000. Le message stocké
 * garde donc toujours l'adresse saisie, il n'y a rien à ré-habiller à l'affichage.
 *
 * La maille est l'adresse, pas le bouton : deux boutons vers la même page partagent un code (clé de la 0107).
 */

/**
 * Au-delà de cette longueur, une adresse part telle quelle, non mesurée : l'index unique sur `destination`
 * (0107) refuserait une valeur démesurée, ce qui ferait échouer l'allocation, donc l'envoi.
 */
export const URL_TRACABLE_MAX = 1000;

/** L'adresse d'un bouton est-elle traçable ? Fonction pure, seule règle d'admission. */
export function estTracable(url: string): boolean {
  const u = url.trim();
  if (u === '' || u.length > URL_TRACABLE_MAX) return false;
  // Une URL à variable n'est jamais substituée en RCS (`src/rcs/variables.ts`) : la tracer figerait une adresse
  // cassée derrière un code.
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
 * Les adresses traçables de ce message, sans doublon (la maille est l'adresse : une allocation par page) et
 * dans l'ordre de première apparition.
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

/** Ce message porte-t-il au moins un lien traçable ? Évite d'aller chercher un jeton pour rien. */
export function aDesLiensTracables(msg: RcsOutbound): boolean {
  return destinationsTracables(msg).length > 0;
}

/**
 * Rend une copie du message dont les boutons `openUrl` listés dans `liens` portent l'adresse de redirection,
 * ou la même référence s'il n'y a rien à changer (l'appelant teste l'identité).
 * Une adresse absente de la table sort inchangée (allocation en échec) : un bouton non mesuré vaut mieux qu'un
 * message amputé ou pas envoyé.
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
