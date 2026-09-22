/**
 * UNE LIGNE DE JOURNAL, en JSON, sur la sortie du process : ce que lit `docker logs`.
 *
 * 🔴 `req.log` ET `app.log` SONT MUETS DANS CE DÉPÔT. Fastify est construit en `logger: false`
 * (`src/server.ts`), et son journal est alors une fonction vide : mesuré le 2026-09-22, `app.log.error` vaut
 * `function noop () { }`. Des appels s'en servaient pour une clé Gateway indéchiffrable, un refus de schéma,
 * un réglage illisible, sous des commentaires qui promettaient la trace ; l'un recevait même `req.log` EN
 * VALEUR, forme qu'aucune recherche ligne à ligne ne voyait. `tests/journal-muet.test.ts` refuse tout accès
 * au journal de Fastify, lu sur l'arbre syntaxique.
 *
 * Même forme que les lignes écrites à la main ailleurs (`{ lvl, msg, ... }`, `src/server.ts`), pour qu'un
 * seul `grep` les retrouve toutes.
 *
 * ⚠️ UNE `Error` NE SE SÉRIALISE PAS : `JSON.stringify(new Error('x'))` rend `{}`. Elle est réduite à son
 * message, sa CAUSE suit sur un niveau (un `fetch failed` ne dit rien sans son `ENOTFOUND`), et sa pile suit
 * au niveau `error`.
 *
 * ⚠️ ET CETTE FONCTION NE LÈVE JAMAIS : elle vit dans des `catch`, et un journal qui casserait remplacerait
 * l'erreur qu'il devait décrire par la sienne. Un champ illisible (valeur circulaire, `BigInt`, pile dont la
 * lecture lève) est remplacé SEUL : il n'emporte pas l'espace ni l'erreur écrits à côté de lui.
 */
export function journaliser(niveau: 'info' | 'warn' | 'error', msg: string, champs: Record<string, unknown> = {}): void {
  const ligne: Record<string, unknown> = { lvl: niveau, msg };
  try {
    for (const [cle, valeur] of Object.entries(champs)) {
      try {
        if (valeur instanceof Error) {
          ligne[cle] = valeur.message;
          if (valeur.cause !== undefined) ligne[`${cle}Cause`] = decrireCause(valeur.cause);
          if (niveau === 'error' && ligne.stack === undefined) {
            try { ligne.stack = valeur.stack; } catch { ligne.stack = '[illisible]'; }
          }
        } else {
          JSON.stringify(valeur); // lève sur une valeur circulaire ou un BigInt : le champ seul sera remplacé
          ligne[cle] = valeur;
        }
      } catch {
        ligne[cle] = '[illisible]';
      }
    }
  } catch {
    ligne.champsIllisibles = true;
  }
  let texte: string;
  try {
    texte = JSON.stringify(ligne);
  } catch {
    texte = JSON.stringify({ lvl: niveau, msg, champsIllisibles: true });
  }
  // eslint-disable-next-line no-console
  (niveau === 'error' ? console.error : niveau === 'warn' ? console.warn : console.log)(texte);
}

/** La cause d'une erreur, sur UN niveau : son code réseau s'il en a un, puis son message. */
function decrireCause(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? `${code} ${cause.message}` : cause.message;
}
