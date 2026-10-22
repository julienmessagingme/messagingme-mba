// Recopié de wagroups, commit 526d3cc, `src/crypto/secretbox.ts`. Changé : `authTagLength` explicite au déchiffrement,
// comme `src/crypto/secretbox.ts` de ce dépôt (sans lui, un tag tronqué serait accepté et faciliterait une forge).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_LONGUEUR = 12;
const TAG_LONGUEUR = 16;

/**
 * Chiffre une valeur en AES-256-GCM. `aad` lie le chiffre a sa ligne : une valeur ne peut pas etre deplacee d'une
 * ligne a une autre sans que le dechiffrement echoue. Sortie : base64 de iv || tag || chiffre.
 */
export function chiffrer(cle: Buffer, clair: string, aad: string): string {
  const iv = randomBytes(IV_LONGUEUR);
  const cipher = createCipheriv('aes-256-gcm', cle, iv, { authTagLength: TAG_LONGUEUR });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const chiffre = Buffer.concat([cipher.update(clair, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), chiffre]).toString('base64');
}

export function dechiffrer(cle: Buffer, charge: string, aad: string): string {
  const brut = Buffer.from(charge, 'base64');
  if (brut.length < IV_LONGUEUR + TAG_LONGUEUR) throw new Error('Charge chiffree trop courte');
  const iv = brut.subarray(0, IV_LONGUEUR);
  const tag = brut.subarray(IV_LONGUEUR, IV_LONGUEUR + TAG_LONGUEUR);
  const chiffre = brut.subarray(IV_LONGUEUR + TAG_LONGUEUR);
  const decipher = createDecipheriv('aes-256-gcm', cle, iv, { authTagLength: TAG_LONGUEUR });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(chiffre), decipher.final()]).toString('utf8');
}

/** La clé de 32 octets tirée d'`ENCRYPTION_KEY` (64 caractères hex), comme le reste du dépôt. */
export function cleDepuisHex(hex: string): Buffer {
  const cle = Buffer.from(hex, 'hex');
  if (cle.length !== 32) throw new Error('ENCRYPTION_KEY invalide : 64 caractères hex attendus (32 octets)');
  return cle;
}
