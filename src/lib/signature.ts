import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Hash sha256 hex d'une chaîne. Pour stocker une clé d'API par son empreinte (jamais le clair), et la
 *  retrouver par index unique (pas de comparaison mémoire -> pas de canal de timing, comme auth_tokens). */
export function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Entrée du signeur de requête cross-repo (mba -> mm-hubspot). Le HMAC lie NON seulement le corps mais aussi
 * un horodatage, un nonce, la méthode et le chemin : un couple (header + corps) capturé n'est plus rejouable
 * indéfiniment (la fenêtre côté vérificateur le borne dans le temps). `ts`/`nonce` sont INJECTÉS (pas de
 * Date.now/randomBytes ici) pour garder la fonction PURE et testable.
 */
export interface RequestSignatureInput {
  /** Horodatage ms epoch (Date.now() côté appelant). */
  ts: number;
  /** Aléa par requête : randomBytes(8).toString('hex') = 16 hex. */
  nonce: string;
  /** Méthode HTTP en MAJUSCULES (ex. 'POST'). */
  method: string;
  /** Chemin (pathname sans query) tel que le vérificateur le verra (req.url sans '?'). */
  path: string;
  /** Corps brut EXACT envoyé (mêmes octets que ceux signés). */
  body: Buffer | string;
}

/**
 * ⚠️ FORMAT CANONIQUE DUPLIQUÉ dans mm-hubspot/src/lib/signature.ts (verifyRequest) — les deux repos ne
 * partagent aucun paquet : la construction de la préimage DOIT rester BYTE-identique (ordre, séparateur '.',
 * casse de method, pathname sans query), sinon 100 % du trafic /ingest et /service tombe en 401 silencieux.
 * Un vecteur d'or figé dans les tests des DEUX repos garde l'invariant.
 * Préimage = utf8(`${ts}.${nonce}.${method}.${path}.`) ++ rawBody. Header = `v1=${ts}.${nonce}.${hmacHex}`.
 */
export function signRequest(secret: string, input: RequestSignatureInput): string {
  const rawBody = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body;
  const prefix = Buffer.from(`${input.ts}.${input.nonce}.${input.method}.${input.path}.`, 'utf8');
  const hex = createHmac('sha256', secret).update(Buffer.concat([prefix, rawBody])).digest('hex');
  return `v1=${input.ts}.${input.nonce}.${hex}`;
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
