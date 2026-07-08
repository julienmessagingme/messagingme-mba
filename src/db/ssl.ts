import { readFileSync } from 'node:fs';

export interface PgSslConfig {
  rejectUnauthorized: boolean;
  ca?: string;
}

/**
 * Config SSL Postgres partagée (pool, pg-boss, migrate). Sécurisée par défaut.
 *
 * Priorité :
 *  0. `DB_SSL=off` -> SSL désactivé (`ssl: false`). Pour un Postgres LOCAL sans TLS
 *     (CI avec service Postgres, dev local) : forcer un objet SSL ferait échouer la
 *     connexion (« server does not support SSL »).
 *  1. `DB_SSL_CA_FILE` (chemin vers la CA, ex. la CA Supabase téléchargée depuis
 *     le dashboard) -> vérification COMPLÈTE du certificat (rejectUnauthorized:true + ca).
 *     C'est la cible prod : anti-MITM réel.
 *  2. `DB_SSL_INSECURE=true` -> pas de vérification (rejectUnauthorized:false).
 *     Fallback documenté : le endpoint DIRECT Supabase (`db.<ref>.supabase.co`) sert une
 *     CA auto-signée absente du trust store Node, donc la vérif stricte échoue sans CA
 *     épinglée. À n'utiliser qu'en dev tant que la CA n'est pas fournie (ou basculer sur
 *     le pooler, dont le cert AWS est publiquement approuvé).
 *  3. sinon -> vérification via le trust store système (rejectUnauthorized:true).
 */
export function pgSsl(): PgSslConfig | false {
  if (process.env['DB_SSL'] === 'off') return false;
  const caFile = process.env['DB_SSL_CA_FILE'];
  if (caFile && caFile.trim()) {
    return { ca: readFileSync(caFile, 'utf8'), rejectUnauthorized: true };
  }
  if (process.env['DB_SSL_INSECURE'] === 'true') {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}
