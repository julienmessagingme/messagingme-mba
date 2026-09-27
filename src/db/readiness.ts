/**
 * Sonde de readiness de l'API : la base est-elle joignable ? Un `select 1` avec un timeout court (2 s), distinct du
 * connectionTimeoutMillis du pool, pour qu'un pool saturé ne fasse pas pendre la sonde. Distinct de /live, qui ne
 * touche jamais la base.
 * La requête expirée continue en arrière-plan et occupe une connexion : ne pas sonder trop souvent (10 à 30 s).
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
      if (timer) clearTimeout(timer); // libère le timer quand la requête gagne
    }
  };
}
