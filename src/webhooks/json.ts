/**
 * Lecture défensive d'un payload de webhook Meta : la forme n'est jamais garantie, et une clé manquante doit
 * donner un vide traversable plutôt qu'un throw en plein traitement d'un événement entrant.
 * `texteNonVide` rend `undefined` (parse, handover) ; `inbound` garde son `str` local, qui rend `null`, car
 * unifier changerait le sens des tests `??` / `!== undefined` de ses appelants. `objetOuNull` sert aussi le MCP.
 */
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Une chaîne non vide, sinon `undefined`. */
export function texteNonVide(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Un objet (jamais un tableau ni `null`), sinon `null`. */
export function objetOuNull(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
