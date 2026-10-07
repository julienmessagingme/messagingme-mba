/**
 * L'ISSUE D'UNE FONCTION MÉTIER PARTAGÉE PAR DEUX PORTES : la route de la console et l'outil MCP.
 *
 * 🔴 UNE SEULE VÉRITÉ, DEUX TRADUCTIONS. La fonction décide (contrôles, refus, phrase) ; la route traduit un refus en
 * statut HTTP avec la même phrase dans `error`, l'outil en refus lisible par un modèle. Né avec les widgets
 * (`src/widgets/gestion.ts`), sorti ici quand l'agent IA, la connaissance et le paiement l'ont repris (lot 8a).
 *
 * Un refus n'est jamais une panne : une panne LÈVE, la route la laisse remonter en 500 et l'outil en erreur
 * interne, sans son message. Le statut ne sert qu'à la route.
 */

/** Les statuts qu'un refus explicable peut prendre. Jamais un 5xx autre que 503 : Cloudflare en remplacerait le corps. */
export type StatutRefus = 400 | 402 | 403 | 404 | 409 | 413 | 415 | 422 | 503;

/**
 * Un refus explicable. `details` porte ce que la route ajoute au corps à côté de `error` (la liste des manques d'un
 * agent, le code d'un refus de paiement), et que l'outil peut rendre au modèle.
 */
export interface Refus {
  ok: false;
  statut: StatutRefus;
  erreur: string;
  details?: Readonly<Record<string, unknown>>;
}

export type Issue<T> = { ok: true; valeur: T } | Refus;

export const refus = (statut: StatutRefus, erreur: string, details?: Readonly<Record<string, unknown>>): Refus =>
  details ? { ok: false, statut, erreur, details } : { ok: false, statut, erreur };

/** Le corps qu'une route rend pour un refus : la phrase dans `error`, et les détails à côté, tels quels. */
export const corpsDuRefus = (r: Refus): Record<string, unknown> => ({ error: r.erreur, ...r.details });
