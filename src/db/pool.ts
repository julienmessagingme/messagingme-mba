import { Pool } from 'pg';
import { config } from '../config';
import { pgSsl } from './ssl';
import { MesureAttentePool, instrumenterPool, type PoolInstrumentable } from './attente-pool';

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
 * `max` et `connectionTimeoutMillis` sont OBLIGATOIRES ici, pas du confort : sans `max`, `pg` en prend 10 par
 * process ; sans timeout, une acquisition sur pool saturé attend INDÉFINIMENT, donc la requête HTTP ne répond
 * jamais et ne laisse aucune trace. Le raisonnement chiffré sur la valeur de `max` (capacité du pooler en mode
 * transaction, pool instancié par process) vit dans `src/config.ts` et NULLE PART AILLEURS, pour qu'il n'y ait
 * qu'un endroit à corriger le jour où elle bouge.
 */
export const pool = new Pool({
  connectionString: resolveAppDatabaseUrl(config),
  ssl: pgSsl(),
  max: config.DB_POOL_MAX,
  connectionTimeoutMillis: config.DB_CONN_TIMEOUT_MS,
});

/**
 * LA MESURE DE L'ATTENTE (lot 7 du plan post-audit). Posée ICI, au point unique de création du pool : tous les
 * stores en héritent et aucun autre fichier ne bouge. Le raisonnement, et pourquoi ce n'est pas une jauge, sont
 * dans `attente-pool.ts`.
 */
export const mesureAttentePool = new MesureAttentePool();
instrumenterPool(pool as unknown as PoolInstrumentable, mesureAttentePool);
