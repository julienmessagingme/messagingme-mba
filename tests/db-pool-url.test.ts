import { describe, it, expect } from 'vitest';
import { resolveAppDatabaseUrl } from '../src/db/pool';

describe('resolveAppDatabaseUrl (pool applicatif : transaction mode avec repli sûr)', () => {
  it('APP_DATABASE_URL défini -> l\'utilise (pooler transaction, port 6543)', () => {
    expect(resolveAppDatabaseUrl({ APP_DATABASE_URL: 'postgres://u@h:6543/db', DATABASE_URL: 'postgres://u@h:5432/db' }))
      .toBe('postgres://u@h:6543/db');
  });

  it('APP_DATABASE_URL vide -> repli sur DATABASE_URL (session, comportement d\'avant)', () => {
    expect(resolveAppDatabaseUrl({ APP_DATABASE_URL: '', DATABASE_URL: 'postgres://u@h:5432/db' }))
      .toBe('postgres://u@h:5432/db');
  });
});

describe('les connexions inactives restent ouvertes (audit du 2026-10-26)', () => {
  // À 10 s (le défaut de `pg`), presque chaque webhook de Meta rouvrait une connexion TLS (13 à 43 ms) pour une requête
  // de 0,5 ms. Les DEUX pools de l'API comptent : la réception de Meta est justement celle qui dort entre deux webhooks.
  it('le pool applicatif et celui de la réception gardent leurs connexions cinq minutes, sondées par keepAlive', async () => {
    const { pool, creerPoolReception } = await import('../src/db/pool');
    const reception = creerPoolReception();
    try {
      for (const p of [pool, reception]) {
        expect(p.options.idleTimeoutMillis).toBe(5 * 60_000);
        expect(p.options.keepAlive).toBe(true);
        expect(p.options.keepAliveInitialDelayMillis).toBe(60_000);
      }
    } finally {
      await reception.end();
    }
  });
});
