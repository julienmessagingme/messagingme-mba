import { renderText } from '../crm/render';
import type { RcsOutbound, RcsCard, RcsSuggestion } from './types';
import { DATE_BOUTON_RE } from './schema';

/**
 * Variables `{{champ}}` dans un message RCS : même contrat que les modèles d'email (`src/crm/render.ts`),
 * variables nommées résolues depuis la fiche, valeur absente = chaîne vide. Rien à voir avec les `{{1}}` des
 * templates Meta.
 *
 * Substitués : le corps (texte, titre et description d'une carte) et les dates d'un bouton Agenda. Pas les
 * libellés de boutons (25 caractères : un prénom long ferait refuser le message entier), ni les URL et
 * numéros d'appel (une variable vide fabriquerait une adresse invalide). Une date d'agenda qui ne se résout
 * pas fait tomber le bouton (`elaguerBoutonsInvalides`), jamais le message.
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
  // Les dates d'agenda comptent : un message dont la seule variable est `{{date_rdv}}` partirait sinon avec
  // ses accolades, et le provider refuserait le message entier.
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

/** Ce message porte-t-il au moins une variable ? Sert à n'aller chercher un contact que si c'est utile. */
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
 * La table de substitution d'un destinataire : les variables qu'il porte (API publique) priment sur les
 * champs de sa fiche du même nom. Construite sans prototype, comme `contactVars`.
 */
export function fusionnerVariables(
  fiche: Readonly<Record<string, string | null>>,
  destinataire: Readonly<Record<string, string>> | null | undefined,
): Record<string, string | null> {
  const out: Record<string, string | null> = Object.create(null);
  for (const [k, v] of Object.entries(fiche)) out[k] = v;
  for (const [k, v] of Object.entries(destinataire ?? {})) out[k] = v;
  return out;
}

/**
 * Retire les boutons qu'un envoi refuserait : un bouton Agenda dont une date n'est pas une date-heure valide
 * (variable non résolue, saisie de travers). Appliqué au point de passage unique de l'envoi, sans condition :
 * sinon le provider refuserait le message entier pour un seul bouton inapplicable.
 */
export function elaguerBoutonsInvalides(msg: RcsOutbound): RcsOutbound {
  const valide = (s: RcsSuggestion): boolean =>
    s.kind !== 'calendar' || (DATE_BOUTON_RE.test(s.startAt) && DATE_BOUTON_RE.test(s.endAt));
  const elaguer = (suggestions: RcsSuggestion[] | undefined): RcsSuggestion[] | undefined => {
    if (!suggestions?.length) return suggestions;
    const gardes = suggestions.filter(valide);
    return gardes.length === suggestions.length ? suggestions : gardes;
  };
  // Un tableau de boutons devenu vide est retiré : `suggestions: []` traverserait jusqu'au corps envoyé, que
  // leur schéma n'attend pas.
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
    // Rien à retirer : même référence en sortie. `RcsSender` s'en sert pour savoir si le message a été modifié.
    if (g === msg.suggestions && c === msg.card) return msg;
    const base = { ...msg, card: c };
    if (g === msg.suggestions) return base;
    return g && g.length ? { ...base, suggestions: g } : sansBoutons(base);
  }
  if (g === msg.suggestions) return msg;
  return g && g.length ? { ...msg, suggestions: g } : sansBoutons({ ...msg });
}
