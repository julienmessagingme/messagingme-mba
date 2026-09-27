import { readFileSync } from 'node:fs';
import { texteDe } from '../lib/erreur';

export interface PgSslConfig {
  rejectUnauthorized: boolean;
  ca?: string;
}

/**
 * Config SSL Postgres partagée (pool, pg-boss, migrate), sécurisée par défaut. Priorité :
 *  0. `DB_SSL=off` : pas de SSL, pour un Postgres local sans TLS (CI, dev).
 *  1. `DB_SSL_CA_FILE` : vérification complète du certificat avec cette CA. La cible en production.
 *  2. `DB_SSL_INSECURE=true` : pas de vérification. L'endpoint direct Supabase sert une CA auto-signée absente du
 *     trust store de Node ; à réserver au dev tant que la CA n'est pas fournie.
 *  3. sinon : vérification par le trust store système.
 */
export function pgSsl(): PgSslConfig | false {
  if (process.env['DB_SSL'] === 'off') return false;
  const caFile = process.env['DB_SSL_CA_FILE'];
  if (caFile && caFile.trim()) {
    let ca: string;
    try {
      ca = readFileSync(caFile, 'utf8');
    } catch (err) {
      // pgSsl() est appelé à l'import : un fichier CA illisible fait tomber l'API et le worker au démarrage. On
      // nomme la variable à corriger plutôt que de laisser un ENOENT opaque.
      throw new Error(`DB_SSL_CA_FILE illisible (${caFile}) : ${texteDe(err)}`);
    }
    return { ca, rejectUnauthorized: true };
  }
  if (process.env['DB_SSL_INSECURE'] === 'true') {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}
