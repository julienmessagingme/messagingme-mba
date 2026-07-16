import { randomBytes, createHash } from 'node:crypto';

/**
 * Identifiants publics « lisibles API » — schéma A : `<type>_<code-client>_<ULID>`.
 * Ex. `scn_k7m2p3_01J9Z3QK8F5A2B7C9D0EF1GH`. Le code est ADDITIF (il n'a jamais vocation à remplacer les
 * clés internes uuid/slug/composite : ce sont elles qui portent les relations). C'est le handle stable pour
 * une future API :
 *  - `type`         : préfixe d'entité (scn/nod/usr/fld/tag) -> on sait ce qu'on regarde.
 *  - `code-client`  : racine STABLE par tenant (posée une fois, immuable), « liée au client ».
 *  - `ULID`         : suffixe unique triable dans le temps, sans compteur ni verrou.
 */

// Alphabet Crockford base32 (sans I, L, O, U — pas d'ambiguïté visuelle).
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type EntityType = 'scn' | 'nod' | 'usr' | 'fld' | 'tag';

/** ULID 26 caractères : 48 bits de temps (10 car., triable) + 80 bits d'aléa (16 car.). */
export function newUlid(now: number = Date.now()): string {
  let t = Math.floor(now);
  let time = '';
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  // 10 octets = 80 bits -> exactement 16 caractères base32 (5 bits chacun).
  let rand = '';
  let value = 0;
  let bits = 0;
  for (const b of randomBytes(10)) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rand += CROCKFORD[(value >> bits) & 31]!;
      value &= (1 << bits) - 1;
    }
  }
  return time + rand;
}

/** Code public d'une entité : `<type>_<tenantCode>_<ULID>`. */
export function makeCode(type: EntityType, tenantCode: string): string {
  return `${type}_${tenantCode}_${newUlid()}`;
}

/**
 * Racine `code-client` STABLE et DÉTERMINISTE dérivée d'un seed (l'uuid du tenant) : 6 caractères base32
 * minuscules. Déterministe -> utilisable à l'identique pour le backfill des tenants existants ET à la création.
 * Immuable (le seed = l'uuid du tenant ne change jamais). Collision astronomiquement improbable à l'échelle
 * (32^6 ≈ 1 milliard) et de toute façon barrée par l'index unique sur `tenants.public_code`.
 */
export function deriveTenantCode(seed: string): string {
  const h = createHash('sha256').update(seed).digest();
  let out = '';
  let value = 0;
  let bits = 0;
  let i = 0;
  while (out.length < 6) {
    value = (value << 8) | h[i]!;
    i += 1;
    bits += 8;
    while (bits >= 5 && out.length < 6) {
      bits -= 5;
      out += CROCKFORD[(value >> bits) & 31]!;
      value &= (1 << bits) - 1;
    }
  }
  return out.toLowerCase();
}
