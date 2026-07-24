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
