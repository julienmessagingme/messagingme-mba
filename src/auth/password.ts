import { scrypt as scryptCb, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const KEYLEN = 64;
const PREFIX = 'scrypt';

/**
 * Hache un mot de passe (scrypt, sel aléatoire), au format `scrypt$<sel hex>$<hash hex>`. Asynchrone
 * (threadpool libuv) : `scryptSync` gèlerait l'event loop, et le hachage est sur des routes publiques
 * (signup, reset) ; un flux de requêtes saturerait le CPU du process qui reçoit aussi les webhooks Meta.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(plain, salt, KEYLEN);
  return `${PREFIX}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Version synchrone, qui bloque l'event loop : hors chemin de requête seulement (le hash leurre calculé une
 *  fois au chargement du module). */
export function hashPasswordSync(plain: string): string {
  const salt = randomBytes(16);
  return `${PREFIX}$${salt.toString('hex')}$${scryptSync(plain, salt, KEYLEN).toString('hex')}`;
}

/**
 * Vérifie un mot de passe contre un hash stocké, comparaison à temps constant. Asynchrone, pour la même
 * raison que `hashPassword`.
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
