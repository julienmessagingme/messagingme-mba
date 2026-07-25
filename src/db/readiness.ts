/**
 * Sonde de READINESS de l'API : la base est-elle joignable ? Un `select 1` avec un timeout COURT (défaut 2 s),
 * INDÉPENDANT du connectionTimeoutMillis (8 s) du pool. Sans ce plafond propre, un pool saturé ferait pendre la
 * sonde 8 s. Fonction fabrique (pool + timeout injectés) -> unit-testable sans DB.
 *
 * ⚠️ La query timeoutée continue en arrière-plan et consomme une acquisition du pool (cap DB_POOL_MAX=3, partagé
 * avec mm-hubspot) : ne pas sonder trop souvent (>= 10-30 s). Distinct de /live (liveness), qui ne touche jamais la DB.
 */
export function makeDbReadinessCheck(
  pool: { query: (text: string) => Promise<unknown> },
  timeoutMs = 2000,
): () => Promise<void> {
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('readiness timeout')), timeoutMs);
    });
    try {
      await Promise.race([pool.query('select 1'), timeout]);
    } finally {
      if (timer) clearTimeout(timer); // libère le timer quand la query gagne (sinon il pend jusqu'au timeout)
    }
  };
}
