import { MetaApiError } from './errors';

/**
 * Résolution du token Meta PAR TENANT (B1). Aujourd'hui tous les envois passaient par UN token global
 * (config.META_ACCESS_TOKEN) et le token business chiffré de chaque client, écrit par l'Embedded Signup dans
 * waba_credentials, n'était jamais relu : la promesse « chaque client branche son numéro » n'était donc que
 * simulée (elle marche parce qu'il n'y a qu'un numéro). Ce module rend la résolution réelle, EN SOMMEIL :
 * tant qu'un WABA n'a pas de credentials propres (cas du numéro branché à la main), on retombe sur le token
 * global -> comportement identique. Dès qu'un client onboarde via Embedded Signup, son token est utilisé.
 */

/** Le token business d'un WABA a été révoqué/expiré : on refuse d'envoyer dessus (au lieu de brûler des appels). */
export class TokenInvalidError extends Error {
  constructor(readonly wabaId: string) {
    super(`token Meta invalide (révoqué/expiré) pour le WABA ${wabaId}`);
    this.name = 'TokenInvalidError';
  }
}

/** Vrai si l'erreur Meta est une erreur d'AUTH (token mort). Règle unique, alignée sur pull.ts. */
export function isMetaAuthError(err: unknown): boolean {
  return err instanceof MetaApiError && (err.code === 190 || err.httpStatus === 401 || err.type === 'OAuthException');
}

export interface WabaCredential {
  businessTokenEnc: string;
  tokenStatus: 'active' | 'invalid';
}

/** Ce dont le résolveur a besoin, injecté (testable sans DB ni réseau). */
export interface CredentialsResolverDeps {
  /** WABA du tenant (null si aucun). */
  getWabaIdForTenant(tenantId: string): Promise<string | null>;
  /** Credentials chiffrés + état d'un WABA (null si aucun -> fallback token global). */
  getCredentialsByWaba(wabaId: string): Promise<WabaCredential | null>;
  /** Marque le token d'un WABA invalide (sur erreur d'auth). Best-effort. */
  markTokenInvalid(wabaId: string): Promise<void>;
  /** Déchiffre le token business (decryptSecret + ENCRYPTION_KEY, injecté pour rester pur). */
  decrypt(enc: string): string;
  /** Token global de repli (config.META_ACCESS_TOKEN) : utilisé quand le WABA n'a pas de credentials propres. */
  fallbackToken: string;
  /** TTL du cache token en ms (défaut 5 min). */
  cacheTtlMs?: number;
  /** Horloge injectable (tests). */
  now?: () => number;
}

/** Token résolu + le WABA d'origine (null = token global de repli, aucun WABA propre à invalider). */
export interface ResolvedToken {
  token: string;
  wabaId: string | null;
}

/**
 * Résout le token d'un tenant. Cache court par WABA (déchiffrer à chaque message coûte). Un WABA sans credentials
 * -> token global (sommeil). Un WABA 'invalid' -> TokenInvalidError. Sinon -> déchiffrement.
 */
export class MetaCredentialsResolver {
  private readonly cache = new Map<string, { token: string; at: number }>();
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(private readonly deps: CredentialsResolverDeps) {
    this.ttl = deps.cacheTtlMs ?? 5 * 60 * 1000;
    this.now = deps.now ?? ((): number => Date.now());
  }

  async resolveForTenant(tenantId: string): Promise<ResolvedToken> {
    const wabaId = await this.deps.getWabaIdForTenant(tenantId);
    if (!wabaId) return { token: this.deps.fallbackToken, wabaId: null };
    return this.resolveForWaba(wabaId);
  }

  async resolveForWaba(wabaId: string): Promise<ResolvedToken> {
    const cached = this.cache.get(wabaId);
    if (cached && this.now() - cached.at < this.ttl) return { token: cached.token, wabaId };

    const cred = await this.deps.getCredentialsByWaba(wabaId);
    if (!cred) return { token: this.deps.fallbackToken, wabaId: null }; // sommeil : pas de credentials propres
    if (cred.tokenStatus === 'invalid') throw new TokenInvalidError(wabaId);

    const token = this.deps.decrypt(cred.businessTokenEnc);
    this.cache.set(wabaId, { token, at: this.now() });
    return { token, wabaId };
  }

  /** Invalide un token (sur erreur d'auth au prochain appel) et PURGE le cache (sinon le token mort resterait servi). */
  async invalidate(wabaId: string): Promise<void> {
    this.cache.delete(wabaId);
    await this.deps.markTokenInvalid(wabaId);
  }

  /** À appeler dans un catch d'appel Meta : si c'est une erreur d'auth ET qu'un WABA propre est en cause, l'invalide. */
  async onError(err: unknown, wabaId: string | null): Promise<void> {
    if (wabaId && isMetaAuthError(err)) await this.invalidate(wabaId);
  }
}
