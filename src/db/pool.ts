import { Pool } from 'pg';
import { config } from '../config';
import { pgSsl } from './ssl';

/** Pool Postgres partagé (worker). Connexion paresseuse. */
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: pgSsl(),
});
