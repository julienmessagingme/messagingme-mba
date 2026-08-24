import { renderText } from '../crm/render';
import type { RcsOutbound, RcsCard } from './types';

/**
 * Variables `{{champ}}` dans un message RCS.
 *
 * MÊME contrat que les modèles d'email (`src/crm/render.ts`), délibérément : variables NOMMÉES, résolues
 * depuis la fiche du contact, valeur absente -> chaîne vide. Rien à voir avec les variables POSITIONNELLES
 * `{{1}}` des templates Meta, qui n'existent que parce que Meta valide un gabarit ; un message RCS n'est
 * soumis à personne, donc rien n'oblige à numéroter.
 *
 * 🔴 CE QUI EST SUBSTITUÉ, ET CE QUI NE L'EST PAS. Le corps du message seulement : texte, titre et
 * description d'une carte. PAS les libellés de boutons (25 caractères maximum : un prénom un peu long ferait
 * refuser le message ENTIER par le provider, pour un gain nul), PAS les URL ni les numéros d'appel (une
 * variable vide fabriquerait une adresse invalide, donc un message refusé au lieu d'un lien approximatif).
 * Cette limite est un choix, pas un oubli : elle est ce qui garantit qu'un message part toujours.
 */

const MOTIF = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Noms des variables utilisées par ce message, dans l'ordre de première apparition, sans doublon. */
export function variablesDe(msg: RcsOutbound): string[] {
  const textes = msg.kind === 'text'
    ? [msg.text]
    : msg.kind === 'card'
      ? [msg.card.title ?? '', msg.card.description ?? '']
      : msg.cards.flatMap((c) => [c.title ?? '', c.description ?? '']);
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

function carteRendue(c: RcsCard, vars: Record<string, string | null | undefined>): RcsCard {
  return {
    ...c,
    ...(c.title !== undefined ? { title: renderText(c.title, vars, { html: false }) } : {}),
    ...(c.description !== undefined ? { description: renderText(c.description, vars, { html: false }) } : {}),
  };
}

/**
 * Message avec ses variables remplacées. `html: false` : un message RCS est du texte brut, l'échappement HTML
 * y écrirait `&amp;` en toutes lettres sur le téléphone du contact.
 */
export function appliquerVariables(msg: RcsOutbound, vars: Record<string, string | null | undefined>): RcsOutbound {
  if (msg.kind === 'text') return { ...msg, text: renderText(msg.text, vars, { html: false }) };
  if (msg.kind === 'card') return { ...msg, card: carteRendue(msg.card, vars) };
  return { ...msg, cards: msg.cards.map((c) => carteRendue(c, vars)) };
}
