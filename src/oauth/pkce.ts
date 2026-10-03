import { hash } from 'node:crypto';
import { timingSafeEqualStr } from '../lib/signature';

/**
 * PKCE (RFC 7636), en S256 seulement : OAuth 2.1 l'exige de tout client, et nos métadonnées n'annoncent que
 * `S256` (sans cette annonce, la spécification MCP fait refuser le client). `plain` n'existe pas ici.
 */

/** Le vérificateur : 43 à 128 caractères non réservés (RFC 7636, 4.1). */
const FORME_VERIFICATEUR = /^[A-Za-z0-9._~-]{43,128}$/;
/** Le défi S256 : le base64url sans remplissage d'un SHA-256, soit exactement 43 caractères. */
const FORME_DEFI = /^[A-Za-z0-9_-]{43}$/;

/** Le défi reçu à `/oauth/authorize` a-t-il la forme d'un défi S256 ? Un défi malformé ne pourrait jamais correspondre. */
export function formeDeDefi(defi: string): boolean {
  return FORME_DEFI.test(defi);
}

/**
 * Le vérificateur présenté à l'échange correspond-il au défi enregistré avec le code ? Comparaison à temps
 * constant : le défi n'est pas secret, mais une comparaison qui s'arrête au premier écart n'a rien à faire sur un
 * chemin d'authentification.
 */
export function verifierPkce(verificateur: string, defi: string): boolean {
  if (!FORME_VERIFICATEUR.test(verificateur)) return false;
  return timingSafeEqualStr(hash('sha256', verificateur, 'base64url'), defi);
}
