import { renderText } from '../crm/render';
import type { RcsOutbound, RcsCard, RcsSuggestion } from './types';
import { DATE_BOUTON_RE } from './schema';

/**
 * Variables `{{champ}}` dans un message RCS.
 *
 * MÊME contrat que les modèles d'email (`src/crm/render.ts`), délibérément : variables NOMMÉES, résolues
 * depuis la fiche du contact, valeur absente -> chaîne vide. Rien à voir avec les variables POSITIONNELLES
 * `{{1}}` des templates Meta, qui n'existent que parce que Meta valide un gabarit ; un message RCS n'est
 * soumis à personne, donc rien n'oblige à numéroter.
 *
 * 🔴 CE QUI EST SUBSTITUÉ, ET CE QUI NE L'EST PAS. Le corps du message (texte, titre et description d'une
 * carte), et les DATES d'un bouton Agenda. PAS les libellés de boutons (25 caractères maximum : un prénom un
 * peu long ferait refuser le message ENTIER par le provider, pour un gain nul), PAS les URL ni les numéros
 * d'appel (une variable vide fabriquerait une adresse invalide, donc un message refusé au lieu d'un lien
 * approximatif).
 *
 * L'exception des dates d'agenda n'affaiblit pas cette règle, elle la respecte : un rendez-vous est propre à
 * chaque contact, une date en dur dans un message réutilisable serait vraie une fois et fausse ensuite, et
 * surtout une date qui ne se résout pas fait tomber LE BOUTON (`elaguerBoutonsInvalides`), jamais le message.
 * La garantie reste la même : un message part toujours.
 */

const MOTIF = /\{\{\s*([\w.-]+)\s*\}\}/g;

function datesAgenda(suggestions: RcsSuggestion[] | undefined): string[] {
  return (suggestions ?? []).flatMap((s) => (s.kind === 'calendar' ? [s.startAt, s.endAt] : []));
}

/** Noms des variables utilisées par ce message, dans l'ordre de première apparition, sans doublon. */
export function variablesDe(msg: RcsOutbound): string[] {
  const corps = msg.kind === 'text'
    ? [msg.text]
    : msg.kind === 'card'
      ? [msg.card.title ?? '', msg.card.description ?? '']
      : msg.cards.flatMap((c) => [c.title ?? '', c.description ?? '']);
  // Les dates d'agenda comptent : sans elles, un message dont la SEULE variable est un `{{date_rdv}}` ne
  // déclencherait aucune résolution, et partirait avec ses accolades dans un champ date. Le provider
  // refuserait alors le message entier.
  const textes = [
    ...corps,
    ...(msg.kind === 'text' || msg.kind === 'card' ? datesAgenda(msg.suggestions) : []),
    ...(msg.kind === 'card' ? datesAgenda(msg.card.suggestions) : []),
    ...(msg.kind === 'carousel' ? msg.cards.flatMap((c) => datesAgenda(c.suggestions)) : []),
  ];
  const vues: string[] = [];
  for (const texte of textes) {
    MOTIF.lastIndex = 0;
    let m = MOTIF.exec(texte);
    while (m !== null) {
      const nom = m[1]!;
      if (!vues.includes(nom)) vues.push(nom);
      m = MOTIF.exec(texte);
    }
  }
  return vues;
}

/** Ce message porte-t-il au moins une variable ? Sert à N'ALLER CHERCHER un contact que si c'est utile. */
export function aDesVariables(msg: RcsOutbound): boolean {
  return variablesDe(msg).length > 0;
}

/** Dates d'agenda résolues. Les autres formes de bouton sortent inchangées. */
function boutonsRendus(
  suggestions: RcsSuggestion[] | undefined,
  vars: Record<string, string | null | undefined>,
): RcsSuggestion[] | undefined {
  if (!suggestions?.length) return suggestions;
  return suggestions.map((s) => (s.kind === 'calendar'
    ? { ...s, startAt: renderText(s.startAt, vars, { html: false }), endAt: renderText(s.endAt, vars, { html: false }) }
    : s));
}

function carteRendue(c: RcsCard, vars: Record<string, string | null | undefined>): RcsCard {
  const boutons = boutonsRendus(c.suggestions, vars);
  return {
    ...c,
    ...(c.title !== undefined ? { title: renderText(c.title, vars, { html: false }) } : {}),
    ...(c.description !== undefined ? { description: renderText(c.description, vars, { html: false }) } : {}),
    ...(boutons ? { suggestions: boutons } : {}),
  };
}

/**
 * Message avec ses variables remplacées. `html: false` : un message RCS est du texte brut, l'échappement HTML
 * y écrirait `&amp;` en toutes lettres sur le téléphone du contact.
 */
export function appliquerVariables(msg: RcsOutbound, vars: Record<string, string | null | undefined>): RcsOutbound {
  if (msg.kind === 'text') {
    const boutons = boutonsRendus(msg.suggestions, vars);
    return { ...msg, text: renderText(msg.text, vars, { html: false }), ...(boutons ? { suggestions: boutons } : {}) };
  }
  if (msg.kind === 'card') {
    const boutons = boutonsRendus(msg.suggestions, vars);
    return { ...msg, card: carteRendue(msg.card, vars), ...(boutons ? { suggestions: boutons } : {}) };
  }
  return { ...msg, cards: msg.cards.map((c) => carteRendue(c, vars)) };
}

/**
 * Retire les boutons qu'un envoi refuserait. Aujourd'hui : un bouton Agenda dont une date n'est pas une
 * date-heure valide, parce que la variable n'a pas été résolue (contact sans valeur, canal de variables non
 * câblé) ou parce qu'elle a été saisie de travers.
 *
 * 🔴 Appliqué au point de passage UNIQUE de l'envoi, pas seulement après une résolution de variables. Sans
 * cette garde inconditionnelle, un message dont la date resterait `{{date_rdv}}` partirait tel quel et le
 * provider refuserait le message ENTIER : un contact sans rendez-vous ne recevrait alors plus rien du tout,
 * alors que le seul élément inapplicable était un bouton.
 */
export function elaguerBoutonsInvalides(msg: RcsOutbound): RcsOutbound {
  const valide = (s: RcsSuggestion): boolean =>
    s.kind !== 'calendar' || (DATE_BOUTON_RE.test(s.startAt) && DATE_BOUTON_RE.test(s.endAt));
  const elaguer = (suggestions: RcsSuggestion[] | undefined): RcsSuggestion[] | undefined => {
    if (!suggestions?.length) return suggestions;
    const gardes = suggestions.filter(valide);
    return gardes.length === suggestions.length ? suggestions : gardes;
  };
  // Un tableau de boutons devenu VIDE est retiré, pas laissé vide : `suggestions: []` traverserait jusqu'au
  // corps envoyé, où une liste vide n'a aucun sens (et que leur schéma n'attend pas).
  const sansBoutons = <T extends { suggestions?: RcsSuggestion[] }>(o: T): T => {
    const copie = { ...o };
    delete copie.suggestions;
    return copie;
  };
  const carte = (c: RcsCard): RcsCard => {
    const g = elaguer(c.suggestions);
    if (g === c.suggestions) return c;
    return g && g.length ? { ...c, suggestions: g } : sansBoutons(c);
  };
  if (msg.kind === 'carousel') {
    const cards = msg.cards.map(carte);
    return cards.every((c, i) => c === msg.cards[i]) ? msg : { ...msg, cards };
  }
  const g = elaguer(msg.suggestions);
  if (msg.kind === 'card') {
    const c = carte(msg.card);
    // Rien à retirer -> le message ressort TEL QUEL, même référence : recopier un objet pour n'y rien changer
    // ne sert qu'à brouiller le raisonnement (et les tests) sur « ce message a-t-il été modifié ? ».
    if (g === msg.suggestions && c === msg.card) return msg;
    const base = { ...msg, card: c };
    if (g === msg.suggestions) return base;
    return g && g.length ? { ...base, suggestions: g } : sansBoutons(base);
  }
  if (g === msg.suggestions) return msg;
  return g && g.length ? { ...msg, suggestions: g } : sansBoutons({ ...msg });
}
