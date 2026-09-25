import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { VERROU_MIGRATIONS } from '../../src/db/migration-directives';

const url = process.env.DATABASE_URL ?? '';

/**
 * Le verrou d'avis qui sérialise les exécutions de migrations (programme II, lot 8).
 *
 * 🔴 EN INTÉGRATION parce que le comportement testé est celui de POSTGRES, pas du nôtre : qu'un second
 * demandeur se voie refuser le verrou, et qu'une session qui meurt le rende toute seule. C'est cette dernière
 * propriété qui rend le verrou sûr en exploitation (rien à nettoyer après un plantage) et elle ne se vérifie
 * que contre une vraie base.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('verrou d’avis des migrations (Postgres)', () => {
  let a: Client;
  let b: Client;

  beforeAll(async () => {
    a = new Client({ connectionString: url, ssl: pgSsl() });
    b = new Client({ connectionString: url, ssl: pgSsl() });
    await a.connect();
    await b.connect();
  });

  afterAll(async () => {
    await a.end().catch(() => {});
    await b.end().catch(() => {});
  });

  it('🔴 la seconde exécution est REFUSÉE tout de suite, elle n’attend pas', async () => {
    // `try` et non `pg_advisory_lock` : deux exécutions simultanées sont une erreur d'exploitation, pas une
    // file d'attente. Un `migrate` qui bloque sans rien dire au milieu d'un déploiement est pire que refusé.
    const premier = await a.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [VERROU_MIGRATIONS]);
    expect(premier.rows[0]!.ok).toBe(true);

    const second = await b.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [VERROU_MIGRATIONS]);
    expect(second.rows[0]!.ok).toBe(false);

    await a.query('select pg_advisory_unlock($1)', [VERROU_MIGRATIONS]);
    const apres = await b.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [VERROU_MIGRATIONS]);
    expect(apres.rows[0]!.ok).toBe(true);
    await b.query('select pg_advisory_unlock($1)', [VERROU_MIGRATIONS]);
  });

  it('🔴 une session qui MEURT rend le verrou : rien à nettoyer après un plantage', async () => {
    // C'est la propriété qui rend ce verrou utilisable en production. S'il fallait le libérer à la main, un
    // `migrate` tué au mauvais moment bloquerait tous les déploiements suivants, et personne ne saurait où
    // chercher.
    const ephemere = new Client({ connectionString: url, ssl: pgSsl() });
    await ephemere.connect();
    const pris = await ephemere.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [VERROU_MIGRATIONS]);
    expect(pris.rows[0]!.ok).toBe(true);
    await ephemere.end(); // la session disparaît sans avoir rien libéré

    // Postgres peut mettre un instant à nettoyer : on laisse quelques essais plutôt qu'un `sleep` arbitraire.
    let rendu = false;
    for (let i = 0; i < 20 && !rendu; i += 1) {
      const essai = await a.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [VERROU_MIGRATIONS]);
      rendu = essai.rows[0]!.ok;
      if (!rendu) await new Promise((r) => { setTimeout(r, 50); });
    }
    expect(rendu).toBe(true);
    await a.query('select pg_advisory_unlock($1)', [VERROU_MIGRATIONS]);
  });
});
