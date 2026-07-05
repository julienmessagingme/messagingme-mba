import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Valide la signature Meta d'un webhook (X-Hub-Signature-256).
 * HMAC-SHA256 du corps brut avec l'app secret, comparaison timing-safe.
 * Retourne false si secret vide, header absent/malformé, ou signature invalide.
 */
export function verifyMetaSignature(
  raw: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!secret || !header) return false;

  const match = /^sha256=([0-9a-f]+)$/i.exec(header.trim());
  const hex = match?.[1];
  if (!hex) return false;

  const expected = createHmac('sha256', secret).update(raw).digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(hex, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;

  return timingSafeEqual(provided, expected);
}
