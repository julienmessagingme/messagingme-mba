import { randomBytes, createHash } from 'node:crypto';

/**
 * Identifiants publics lisibles par l'API : `<type>_<code-client>_<ULID>` (ex. `scn_k7m2p3_01J9Z3QK8F5A2B7C9D0EF1GH`).
 * Additif : les relations restent portées par les clés internes (uuid, slug, composite).
 *  - `type` : préfixe d'entité (scn/nod/usr/fld/tag) ;
 *  - `code-client` : racine stable et immuable par espace ;
 *  - `ULID` : suffixe unique triable dans le temps, sans compteur ni verrou.
 */

// Alphabet Crockford base32 (sans I, L, O, U : pas d'ambiguïté visuelle).
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
  return time + base32(randomBytes(10), 16);
}

/**
 * Les `n` premiers caractères base32 (Crockford, majuscules) des octets donnés, lus 5 bits par 5 bits. Les bits en
 * trop sont ignorés : l'appelant fournit au moins `ceil(5n/8)` octets.
 */
function base32(octets: Uint8Array, n: number): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const b of octets) {
    if (out.length >= n) break;
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < n) {
      bits -= 5;
      out += CROCKFORD[(value >> bits) & 31]!;
      value &= (1 << bits) - 1;
    }
  }
  return out;
}

/** Code public d'une entité : `<type>_<tenantCode>_<ULID>`. */
export function makeCode(type: EntityType, tenantCode: string): string {
  return `${type}_${tenantCode}_${newUlid()}`;
}

/**
 * Code d'un lien de redirection tracé : 12 caractères base32 minuscules, tirés au sort (60 bits, la route est
 * publique). Court, parce qu'il voyage dans une URL de bouton limitée par Meta ; sans code client ni horodatage,
 * qui se liraient de l'extérieur et diraient qui envoie et quand.
 */
export function newTrackingCode(): string {
  return codeAleatoire(12);
}

/**
 * Code public d'un webhook entrant : 26 caractères base32 minuscules, 130 bits. Ce n'est pas un identifiant mais
 * la clé d'accès (il suffit pour poster dans un espace) : rien ne justifie d'économiser sur l'aléa.
 */
export function newWebhookCode(): string {
  return codeAleatoire(26);
}

/**
 * Code public d'un visuel de message RCS : 26 caractères, comme un webhook. La route qui sert l'image est publique
 * (l'opérateur télécom la télécharge sans session) : ce code est ce qui donne accès au fichier.
 */
export function newMediaCode(): string {
  return codeAleatoire(26);
}

/** Chaîne base32 (Crockford) minuscule de `longueur` caractères, tirée au sort. */
function codeAleatoire(longueur: number): string {
  return base32(randomBytes(Math.ceil((longueur * 5) / 8)), longueur).toLowerCase();
}

// Le format `fld_<tenantCode>_sys_<key>` reste réservé : généré par le front (`web/lib/codes.ts`), reconnu côté
// serveur par `SYS_RE` dans `src/ids/resolve.ts`.

/**
 * Racine `code-client` d'un espace : 6 caractères base32 minuscules dérivés de son uuid, donc déterministes
 * (backfill et création donnent le même) et immuables. Une collision est barrée par l'index unique sur
 * `tenants.public_code`.
 */
export function deriveTenantCode(seed: string): string {
  return base32(createHash('sha256').update(seed).digest(), 6).toLowerCase();
}
