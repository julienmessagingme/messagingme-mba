import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Chiffrement au repos des secrets (tokens business Embedded Signup) : AES-256-GCM, clé 32 octets
 * fournie en hex (env ENCRYPTION_KEY, 64 caractères). Format du payload : `v1.<iv>.<tag>.<data>`
 * (base64) — versionné pour permettre une rotation d'algo sans casser l'existant.
 *
 * 🔴 `authTagLength` EST EXPLICITE DES DEUX CÔTÉS (2026-09-10), et ce n'est pas une redondance avec le
 * défaut de Node. Sans lui, `createDecipheriv` ACCEPTE un tag plus court que 16 octets : un attaquant
 * capable de fournir le texte chiffré peut alors tronquer le tag, ce qui divise d'autant le travail d'une
 * forge. C'est la seule chose que semgrep a trouvée dans le dépôt à la première exécution du contrôle
 * ajouté ce jour-là (`javascript.node-crypto.security.gcm-no-tag-length`).
 *
 * ⚠️ AUCUN SECRET EXISTANT N'EN SOUFFRE, et ça a été MESURÉ avant d'écrire la ligne : les 224 colonnes
 * texte de la base de production ont été balayées à la recherche du format `v1.`, huit en portent (jetons
 * business Meta, code PIN, mot de passe SMTP, jetons RCS, secrets Channels Me, clé AI Gateway), et les huit
 * ont un tag de 16 octets. Le défaut de Node ÉTAIT 16 : l'expliciter fige ce qui existe déjà au lieu de
 * changer quoi que ce soit. Sans cette mesure, la même ligne aurait pu rendre illisible un secret de
 * production, sans aucun moyen de revenir en arrière.
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
