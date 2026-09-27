import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Chiffrement au repos des secrets : AES-256-GCM, clé de 32 octets en hex (ENCRYPTION_KEY, 64 caractères). Format
 * `v1.<iv>.<tag>.<data>` (base64), versionné pour une rotation d'algorithme.
 *
 * 🔴 `authTagLength` explicite des deux côtés : sans lui, `createDecipheriv` accepte un tag de moins de 16 octets,
 * et un attaquant qui fournit le texte chiffré peut tronquer le tag pour faciliter une forge. Tous les secrets
 * existants ont un tag de 16 octets (le défaut de Node) : ne jamais changer cette longueur.
 */
const LONGUEUR_TAG = 16;

function keyFromHex(keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY invalide : 64 caractères hex attendus (32 octets)');
  return key;
}

export function encryptSecret(plaintext: string, keyHex: string): string {
  const key = keyFromHex(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: LONGUEUR_TAG });
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(payload: string, keyHex: string): string {
  const key = keyFromHex(keyHex);
  const [v, ivB64, tagB64, dataB64] = payload.split('.');
  if (v !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('secret chiffré malformé');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'), { authTagLength: LONGUEUR_TAG });
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
