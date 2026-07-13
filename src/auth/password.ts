import { scrypt as scryptCb, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const KEYLEN = 64;
const PREFIX = 'scrypt';

/**
 * Hash un mot de passe (scrypt + sel aléatoire), Format : `scrypt$<sel hex>$<hash hex>`. ASYNCHRONE
 * (threadpool libuv) comme verifyPassword : `scryptSync` gèlerait l'event loop mono-thread, et le hachage est
 * désormais sur des routes PUBLIQUES (signup/reset) -> un flux de requêtes saturerait le CPU (DoS, impacte aussi
 * la réception webhook Meta dans le même process). À utiliser sur tout chemin de requête.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(plain, salt, KEYLEN);
  return `${PREFIX}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Version SYNCHRONE (bloque l'event loop) : réservée aux usages HORS chemin de requête, ex. le hash leurre
 *  calculé UNE fois au chargement du module. NE PAS utiliser par requête. */
export function hashPasswordSync(plain: string): string {
  const salt = randomBytes(16);
  return `${PREFIX}$${salt.toString('hex')}$${scryptSync(plain, salt, KEYLEN).toString('hex')}`;
}

/**
 * Vérifie un mot de passe contre un hash stocké (comparaison à temps constant). Le scrypt
 * est ASYNCHRONE (threadpool libuv) pour ne pas geler l'event loop mono-thread : un flux de
 * logins ne peut pas provoquer un DoS par saturation CPU du serveur.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== PREFIX) return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  if (expected.length === 0) return false;
  const actual = await scrypt(plain, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
