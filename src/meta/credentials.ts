import { MetaApiError } from './errors';
import { messageDe } from '../lib/erreur';

/**
 * Résolution du token Meta par tenant. Un WABA sans credentials propres (numéro branché à la main) retombe sur
 * le token global ; un WABA embarqué par Embedded Signup utilise son token business chiffré (`waba_credentials`).
 */

/** Le token business d'un WABA a été révoqué ou a expiré : on refuse d'envoyer dessus plutôt que de brûler des appels. */
export class TokenInvalidError extends Error {
  constructor(readonly wabaId: string) {
    super(`token Meta invalide (révoqué/expiré) pour le WABA ${wabaId}`);
    this.name = 'TokenInvalidError';
  }
}

/** Vrai si l'erreur Meta est une erreur d'auth (token mort). Règle unique, alignée sur pull.ts. */
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
  /** Les credentials des WABA. */
  credentials: {
    /** Credentials chiffrés + état d'un WABA (null si aucun -> fallback token global). */
    getCredentialsByWaba(wabaId: string): Promise<WabaCredential | null>;
    /** Marque le token d'un WABA invalide (sur erreur d'auth). Best-effort. */
    markTokenInvalid(wabaId: string): Promise<void>;
  };
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
 * Résout le token d'un tenant, avec un cache court par WABA (déchiffrer à chaque message coûte). Un WABA sans
 * credentials -> token global ; un WABA 'invalid' -> TokenInvalidError ; sinon déchiffrement.
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

    const cred = await this.deps.credentials.getCredentialsByWaba(wabaId);
    if (!cred) return { token: this.deps.fallbackToken, wabaId: null }; // pas de credentials propres
    if (cred.tokenStatus === 'invalid') throw new TokenInvalidError(wabaId);

    const token = this.deps.decrypt(cred.businessTokenEnc);
    this.cache.set(wabaId, { token, at: this.now() });
    return { token, wabaId };
  }

  /**
   * Invalide un token et purge le cache (sinon le token mort resterait servi). Best-effort : un échec de
   * `markTokenInvalid` est avalé pour ne pas masquer l'erreur Meta d'origine, que l'appelant relance.
   */
  async invalidate(wabaId: string): Promise<void> {
    this.cache.delete(wabaId);
    try {
      await this.deps.credentials.markTokenInvalid(wabaId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`markTokenInvalid ignoré pour ${wabaId}:`, messageDe(err));
    }
  }

  /** À appeler dans un catch d'appel Meta : si c'est une erreur d'auth et qu'un WABA propre est en cause, l'invalide. */
  async onError(err: unknown, wabaId: string | null): Promise<void> {
    if (wabaId && isMetaAuthError(err)) await this.invalidate(wabaId);
  }
}
