/**
 * Une ligne de journal, en JSON, sur la sortie du process : ce que lit `docker logs`.
 *
 * `req.log` et `app.log` sont muets dans ce dépôt (Fastify en `logger: false`, son journal est une fonction
 * vide) : on passe par ici, et `tests/journal-muet.test.ts` refuse tout accès au journal de Fastify.
 * L'espace s'écrit `tenantId`, jamais `tenant`, pour qu'une recherche par espace retrouve toutes les lignes.
 *
 * Une `Error` ne se sérialise pas (`JSON.stringify` rend `{}`) : elle est réduite à son message, sa cause suit
 * sur un niveau, sa pile au niveau `error`. La fonction ne lève jamais (elle vit dans des `catch`) : un champ
 * illisible est remplacé seul, sans emporter les autres.
 */
export function journaliser(niveau: 'info' | 'warn' | 'error', msg: string, champs: Record<string, unknown> = {}): void {
  const ligne: Record<string, unknown> = { lvl: niveau, msg };
  try {
    for (const [cle, valeur] of Object.entries(champs)) {
      try {
        if (valeur instanceof Error) {
          // `String` : un message qui n'est pas une chaîne ferait tomber la ligne entière à l'écriture.
          ligne[cle] = String(valeur.message);
          // Cause et pile ont chacune leur `try` : illisibles, elles se perdent seules, sans emporter le message.
          try {
            const cause: unknown = valeur.cause;
            if (cause !== undefined) ligne[`${cle}Cause`] = decrireCause(cause);
          } catch {
            ligne[`${cle}Cause`] = '[illisible]';
          }
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

/** La cause d'une erreur, sur un niveau : son code réseau s'il en a un, puis son message. */
function decrireCause(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? `${code} ${cause.message}` : cause.message;
}
