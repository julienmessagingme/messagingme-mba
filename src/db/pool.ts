import { Pool } from 'pg';
import { config } from '../config';
import { pgSsl } from './ssl';

/**
 * URL du pool APPLICATIF : le pooler mode TRANSACTION (APP_DATABASE_URL, port 6543) s'il est défini, sinon repli
 * sur DATABASE_URL (session mode). Fonction PURE et exportée pour être testée. Le repli est une dégradation SÛRE :
 * APP_DATABASE_URL oublié -> retour immédiat au comportement session mode d'avant, sans changement de code (et le
 * rollback prod = vider APP_DATABASE_URL + recréer le conteneur).
 * ⚠️ pg-boss (src/index.ts / src/worker.ts) NE passe PAS par ici : il garde `config.DATABASE_URL` (session mode),
 * le transaction pooling casserait ses connexions longues et sa maintenance.
 */
export function resolveAppDatabaseUrl(cfg: { APP_DATABASE_URL: string; DATABASE_URL: string }): string {
  return cfg.APP_DATABASE_URL || cfg.DATABASE_URL;
}

/**
 * Pool Postgres applicatif partagé (tous les stores, API + worker). Connexion paresseuse.
 *
 * `max` et `connectionTimeoutMillis` sont OBLIGATOIRES ici, pas du confort : le pooler Supabase est plafonné
 * (~15 clients) et partagé avec mm-hubspot. Sans `max`, `pg` en prend 10 par process ; sans timeout, une
 * acquisition sur pool saturé attend INDÉFINIMENT, donc la requête HTTP ne répond jamais et ne laisse aucune
 * trace. Cf. `src/config.ts` pour l'arithmétique du budget et le mode transaction (APP_DATABASE_URL).
 */
export const pool = new Pool({
  connectionString: resolveAppDatabaseUrl(config),
  ssl: pgSsl(),
  max: config.DB_POOL_MAX,
  connectionTimeoutMillis: config.DB_CONN_TIMEOUT_MS,
});
