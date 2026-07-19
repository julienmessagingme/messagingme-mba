import { Pool } from 'pg';
import { config } from '../config';
import { pgSsl } from './ssl';

/**
 * Pool Postgres partagé. Connexion paresseuse.
 *
 * `max` et `connectionTimeoutMillis` sont OBLIGATOIRES ici, pas du confort : le pooler Supabase est en session
 * mode (~15 clients) et partagé avec mm-hubspot. Sans `max`, `pg` en prend 10 par process ; sans timeout, une
 * acquisition sur pool saturé attend INDÉFINIMENT, donc la requête HTTP ne répond jamais et ne laisse aucune
 * trace. Cf. `src/config.ts` pour l'arithmétique du budget.
 */
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: pgSsl(),
  max: config.DB_POOL_MAX,
  connectionTimeoutMillis: config.DB_CONN_TIMEOUT_MS,
});
