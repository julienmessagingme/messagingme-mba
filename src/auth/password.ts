import { scrypt as scryptCb, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const KEYLEN = 64;
const PREFIX = 'scrypt';

/** Hash un mot de passe (scrypt + sel aléatoire). Format : `scrypt$<sel hex>$<hash hex>`. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN);
  return `${PREFIX}$${salt.toString('hex')}$${hash.toString('hex')}`;
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
