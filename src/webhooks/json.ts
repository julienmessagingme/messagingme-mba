/**
 * Lecture défensive d'un payload de webhook Meta : la forme n'est jamais garantie, et une clé manquante doit
 * donner un vide traversable plutôt qu'un throw en plein traitement d'un événement entrant.
 *
 * Partagés parce que les trois lecteurs du dossier (parse, inbound, handover) en portaient chacun une copie.
 * `str` reste LOCAL à chacun : ils ne s'accordent pas sur la sentinelle (null ici, undefined là), et unifier
 * changerait le sens des tests `?? ` / `!== undefined` de leurs appelants.
 */
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
