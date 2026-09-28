import { Pool } from 'pg';
import { config } from '../config';
import { pgSsl } from './ssl';
import { MesureAttentePool, instrumenterPool, type PoolInstrumentable } from './attente-pool';
import { ecouterErreursDuPool } from './erreurs-pool';

/**
 * URL du pool applicatif : le pooler en mode transaction (APP_DATABASE_URL, port 6543) s'il est défini, sinon
 * DATABASE_URL (mode session), repli sûr (vider APP_DATABASE_URL suffit à revenir en arrière).
 * Le pg-boss du WORKER ne passe pas par ici : il garde `config.DATABASE_URL`, le mode transaction casserait son
 * écoute et sa maintenance. Celui de l'API, qui ne fait qu'empiler, EMPRUNTE ce pool (`new PgBossQueue(pool)`).
 */
export function resolveAppDatabaseUrl(cfg: { APP_DATABASE_URL: string; DATABASE_URL: string }): string {
  return cfg.APP_DATABASE_URL || cfg.DATABASE_URL;
}

/**
 * Pool Postgres applicatif partagé (tous les stores, API et worker), à connexion paresseuse.
 * `max` et `connectionTimeoutMillis` sont obligatoires : sans `max`, `pg` en prend 10 par process ; sans timeout,
 * une acquisition sur pool saturé attend indéfiniment et la requête HTTP ne répond jamais. Le calcul de `max` vit
 * dans `src/config.ts`, et nulle part ailleurs.
 */
export const pool = new Pool({
  connectionString: resolveAppDatabaseUrl(config),
  ssl: pgSsl(),
  max: config.DB_POOL_MAX,
  connectionTimeoutMillis: config.DB_CONN_TIMEOUT_MS,
});
ecouterErreursDuPool(pool);

/** La mesure de l'attente, posée au point unique de création du pool : tous les stores en héritent (`attente-pool.ts`). */
export const mesureAttentePool = new MesureAttentePool();
instrumenterPool(pool as unknown as PoolInstrumentable, mesureAttentePool);
