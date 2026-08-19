import type { AuditEntry } from './api';

/**
 * Journal des actions : libellés et mise en forme, séparés de l'écran pour être vérifiables.
 *
 * L'export CSV et l'affichage doivent dire LA MÊME CHOSE : deux tables de libellés auraient dérivé, et un
 * export qui ne correspond plus à ce qu'on a sous les yeux ne sert plus de preuve.
 */

/** Libellés des actions journalisées, en français puis en anglais. */
export const ACTIONS_JOURNAL: Record<string, [string, string]> = {
  'contact.created': ['Contact ajouté', 'Contact added'],
  'contact.imported': ['Import de contacts', 'Contact import'],
  'contact.purged': ['Contact supprimé', 'Contact deleted'],
  'contact.optin': ['Passage en opt-in', 'Marked as opted in'],
  'contact.optout': ['Passage en opt-out', 'Marked as opted out'],
};

/** Détail compact : « created 2 · optIn oui ». Rien à interpréter, ce sont des compteurs et des drapeaux. */
export function resumeDetail(detail: Record<string, unknown>, oui: string, non: string): string {
  return Object.entries(detail)
    .map(([k, v]) => `${k} ${typeof v === 'boolean' ? (v ? oui : non) : String(v)}`)
    .join(' · ');
}

/** Ce qu'il faut traduire pour produire le CSV : l'appelant tient `useT`, pas cette fonction. */
export interface LibellesJournal {
  action: (action: string) => string;
  oui: string;
  non: string;
  /** Acteur absent = le système (webhook, balayage), pas un humain. */
  systeme: string;
}

/**
 * Lignes du CSV du journal, dans l'ordre des en-têtes.
 *
 * La date part en ISO 8601 BRUTE, pas au format français : un CSV se trie et se rejoue, et « 19/08/26 22:14 »
 * ne se trie pas. La cible reste l'identifiant interne, comme à l'écran : le journal ne porte aucun numéro,
 * et l'exporter ne doit pas devenir la faille qui en réintroduit un.
 */
export function lignesJournalCsv(entries: readonly AuditEntry[], l: LibellesJournal): string[][] {
  return entries.map((e) => [
    e.at,
    l.action(e.action),
    e.actorEmail ?? l.systeme,
    e.targetKind,
    e.targetId,
    resumeDetail(e.detail, l.oui, l.non),
  ]);
}
