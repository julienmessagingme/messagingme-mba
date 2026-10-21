import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * La signature d'un webhook Shopify (`X-Shopify-Hmac-Sha256`) : le HMAC SHA-256 du CORPS BRUT, en base64, avec le
 * secret de l'app de la boutique (mesuré le 2026-10-21 sur de vrais webhooks, plan du connecteur, lot 0).
 *   - 🔴 sur le corps brut, tel que reçu : un JSON relu puis réécrit n'a plus les mêmes octets ;
 *   - comparaison à temps constant, sur les octets décodés ;
 *   - Shopify ne signe aucun horodatage : le rejeu se borne par le dédoublonnage des événements, pas ici.
 */
export function verifierSignatureShopify(brut: Buffer, entete: string | undefined, secret: string): boolean {
  // Un secret vide signerait avec une clé que tout le monde connaît : refus, jamais une vérification.
  if (!secret || !entete || !/^[A-Za-z0-9+/]{43}=$/.test(entete)) return false;
  const attendue = createHmac('sha256', secret).update(brut).digest();
  return timingSafeEqual(Buffer.from(entete, 'base64'), attendue);
}
