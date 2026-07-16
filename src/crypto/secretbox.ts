import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Chiffrement au repos des secrets (tokens business Embedded Signup) : AES-256-GCM, clé 32 octets
 * fournie en hex (env ENCRYPTION_KEY, 64 caractères). Format du payload : `v1.<iv>.<tag>.<data>`
 * (base64) — versionné pour permettre une rotation d'algo sans casser l'existant.
 */

function keyFromHex(keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY invalide : 64 caractères hex attendus (32 octets)');
  return key;
}

export function encryptSecret(plaintext: string, keyHex: string): string {
  const key = keyFromHex(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(payload: string, keyHex: string): string {
  const key = keyFromHex(keyHex);
  const [v, ivB64, tagB64, dataB64] = payload.split('.');
  if (v !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('secret chiffré malformé');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
