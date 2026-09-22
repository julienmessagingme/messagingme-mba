/**
 * UNE LIGNE DE JOURNAL, en JSON, sur la sortie du process : ce que lit `docker logs`.
 *
 * 🔴 `req.log` ET `app.log` SONT MUETS DANS CE DÉPÔT. Fastify est construit en `logger: false`
 * (`src/server.ts`), et son journal est alors une fonction vide : mesuré le 2026-09-22, `app.log.error` vaut
 * `function noop () { }`. Treize appels s'en servaient, dont la clé Gateway indéchiffrable, les verrous posés
 * depuis `/ops` et le refus de schéma de l'assistant de construction, sous des commentaires qui promettaient
 * « sans cette ligne, personne ne l'apprend jamais ». Personne ne l'apprenait. `tests/journal-muet.test.ts`
 * interdit d'y revenir.
 *
 * Même forme que les lignes écrites à la main ailleurs (`{ lvl, msg, ... }`, `src/server.ts`), pour qu'un
 * seul `grep` les retrouve toutes.
 *
 * ⚠️ UNE `Error` NE SE SÉRIALISE PAS : `JSON.stringify(new Error('x'))` rend `{}`, et la ligne perdrait
 * exactement ce qu'elle devait garder. Elle est réduite à son message, et sa pile suit au niveau `error`.
 *
 * ⚠️ ET CETTE FONCTION NE LÈVE JAMAIS : elle est appelée depuis des `catch`, et un journal qui casserait
 * (valeur circulaire, `BigInt`) remplacerait l'erreur qu'il devait décrire par la sienne.
 */
export function journaliser(niveau: 'info' | 'warn' | 'error', msg: string, champs: Record<string, unknown> = {}): void {
  const ligne: Record<string, unknown> = { lvl: niveau, msg };
  for (const [cle, valeur] of Object.entries(champs)) {
    if (valeur instanceof Error) {
      ligne[cle] = valeur.message;
      if (niveau === 'error' && ligne.stack === undefined) ligne.stack = valeur.stack;
    } else {
      ligne[cle] = valeur;
    }
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
