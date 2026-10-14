import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { texteDe } from '../lib/erreur';

export interface PgSslConfig {
  rejectUnauthorized: boolean;
  ca?: string;
  checkServerIdentity?: (nom: string, cert: PeerCertificate) => Error | undefined;
}

/**
 * L'hôte d'une chaîne de connexion ; null si elle est absente ou illisible. Une adresse IPv6 garde ses crochets, donc
 * le contrôle par défaut : le Node de production (22) ne sait pas la rapprocher d'un certificat (mesuré le 2026-10-14).
 */
function hoteDe(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Config SSL Postgres partagée (pool, pg-boss, migrate), sécurisée par défaut. Priorité :
 *  0. `DB_SSL=off` : pas de SSL, pour un Postgres local sans TLS (CI, dev).
 *  1. `DB_SSL_CA_FILE` : vérification complète du certificat avec cette CA. La cible en production.
 *  2. `DB_SSL_INSECURE=true` : pas de vérification. L'endpoint direct Supabase sert une CA auto-signée absente du
 *     trust store de Node ; à réserver au dev tant que la CA n'est pas fournie.
 *  3. sinon : vérification par le trust store système.
 *
 * `url` est la base que l'appelant va joindre (par défaut `DATABASE_URL`) : elle ne sert qu'à vérifier une base jointe
 * par son ADRESSE IP. Un appelant qui joint une autre base la passe.
 */
export function pgSsl(url: string | undefined = process.env['DATABASE_URL']): PgSslConfig | false {
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
    // 🔴 Une base jointe par son ADRESSE IP (Scaleway, sur le réseau privé) : node-postgres ne transmet pas l'hôte au
    // contrôle TLS quand c'est une IP (le SNI l'interdit), et Node compare alors le certificat à « localhost ». Refus
    // ERR_TLS_CERT_ALTNAME_INVALID au premier déploiement d'essai, le 2026-10-14. Le contrôle se fait donc contre
    // l'adresse réelle, sur les adresses IP que porte le certificat : rien n'est relâché. Un hôte NOMMÉ (Supabase)
    // garde le contrôle par défaut de Node.
    const hote = hoteDe(url);
    if (hote !== null && isIP(hote) !== 0) {
      return { ca, rejectUnauthorized: true, checkServerIdentity: (_nom, cert) => checkServerIdentity(hote, cert) };
    }
    return { ca, rejectUnauthorized: true };
  }
  if (process.env['DB_SSL_INSECURE'] === 'true') {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}
