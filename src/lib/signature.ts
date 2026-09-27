import { createHmac, hash, timingSafeEqual } from 'node:crypto';

/** Hash sha256 hex d'une chaîne. Une clé d'API se stocke par son empreinte (jamais le clair) et se retrouve par
 *  index unique : pas de comparaison en mémoire, donc pas de canal de timing. */
export function sha256Hex(raw: string): string {
  return hash('sha256', raw);
}

/**
 * Entrée du signeur de requête vers mm-hubspot. Le HMAC lie le corps, un horodatage, un nonce, la méthode et le
 * chemin : un couple (en-tête + corps) capturé n'est rejouable que dans la fenêtre du vérificateur. `ts` et
 * `nonce` sont injectés pour garder la fonction pure et testable.
 */
export interface RequestSignatureInput {
  /** Horodatage ms epoch (Date.now() côté appelant). */
  ts: number;
  /** Aléa par requête : randomBytes(8).toString('hex') = 16 hex. */
  nonce: string;
  /** Méthode HTTP en majuscules (ex. 'POST'). */
  method: string;
  /** Chemin (pathname sans query) tel que le vérificateur le verra (req.url sans '?'). */
  path: string;
  /** Corps brut exact envoyé (mêmes octets que ceux signés). */
  body: Buffer | string;
}

/**
 * Format canonique dupliqué dans mm-hubspot (`src/lib/signature.ts`, `verifyRequest`), sans paquet partagé :
 * la préimage doit rester identique à l'octet (ordre, séparateur '.', casse de method, pathname sans query),
 * sinon tout le trafic /ingest et /service tombe en 401. Un vecteur d'or figé dans les tests des deux dépôts
 * le tient.
 * Préimage = utf8(`${ts}.${nonce}.${method}.${path}.`) ++ rawBody. Header = `v1=${ts}.${nonce}.${hmacHex}`.
 */
export function signRequest(secret: string, input: RequestSignatureInput): string {
  const rawBody = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body;
  const prefix = Buffer.from(`${input.ts}.${input.nonce}.${input.method}.${input.path}.`, 'utf8');
  const hex = createHmac('sha256', secret).update(Buffer.concat([prefix, rawBody])).digest('hex');
  return `v1=${input.ts}.${input.nonce}.${hex}`;
}

/**
 * Valide une signature `v1=` entrante (le webhook HubSpot), au format canonique ci-dessus : miroir de
 * `verifyRequest` du connecteur. `method` et `path` viennent de la requête, jamais d'un en-tête : aucune
 * ambiguïté de délimiteur, même si un chemin contient un point.
 *
 * La fenêtre borne le rejeu à sa durée sans l'empêcher dedans : acceptable parce que le traitement en aval est
 * idempotent (dédup par eventId côté connecteur, anti-rebond par contact côté automation).
 */
export function verifyRequest(
  raw: Buffer,
  header: string | undefined,
  secret: string,
  opts: { method: string; path: string; now: number; windowMs: number },
): boolean {
  if (!secret || !header) return false;

  const match = /^v1=(\d{1,15})\.([0-9a-f]{16})\.([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const [, tsStr, nonce, hex] = match;
  if (tsStr === undefined || nonce === undefined || hex === undefined) return false;

  const prefix = Buffer.from(`${tsStr}.${nonce}.${opts.method}.${opts.path}.`, 'utf8');
  const expected = createHmac('sha256', secret).update(Buffer.concat([prefix, raw])).digest();
  const provided = Buffer.from(hex, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return false;

  // Fenêtre vérifiée après la signature : pas de canal de timing sur la fraîcheur avant l'authentification.
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return false;
  const age = opts.now - ts;
  return age <= opts.windowMs && age >= -opts.windowMs;
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
