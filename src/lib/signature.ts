import { createHmac, timingSafeEqual } from 'node:crypto';

/** Signe un corps brut : `sha256=<hex>` (HMAC-SHA256). Utilisé pour signer le push d'analyse vers le connecteur mm-hubspot. */
export function signHmac(secret: string, raw: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

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

/** Comparaison de chaînes en temps constant (longueur d'abord). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
