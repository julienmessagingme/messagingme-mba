/**
 * Les seuls champs du contact dont un paramètre d'outil peut dériver (`source: 'contact'`).
 *
 * 🔴 FERMÉE EXPRÈS. La projection du contact passée au tour (`src/worker.ts`) peut s'élargir un jour ; la
 * surface offerte à un connecteur ne doit pas suivre toute seule. Un `contactPath` libre ferait dériver un
 * paramètre de n'importe quelle clé future, y compris d'une qu'on aurait ajoutée pour tout autre chose.
 *
 * ⚠️ `wa_id` est dans la liste mais ne vient PAS de la projection : il vient du contexte du TOUR, où il est
 * arrivé par la signature du webhook Meta. Voir l'étape 4 de `src/agent/executor.ts`.
 */
export const CHAMPS_CONTACT_AUTORISES = ['wa_id', 'nom'] as const;

export type ChampContact = (typeof CHAMPS_CONTACT_AUTORISES)[number];

export function estChampContact(v: unknown): v is ChampContact {
  return typeof v === 'string' && (CHAMPS_CONTACT_AUTORISES as readonly string[]).includes(v);
}
