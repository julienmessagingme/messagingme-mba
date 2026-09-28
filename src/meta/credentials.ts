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
    /**
     * Marque invalide le token d'un WABA, SEULEMENT s'il est encore celui qui a échoué (`businessTokenEnc`, le chiffré
     * lu avant l'appel). Best-effort. Sans cette condition, une copie qui garde l'ancien jeton en cache après une
     * reconnexion prendrait un 190 et marquerait invalide le jeton NEUF.
     */
    markTokenInvalid(wabaId: string, businessTokenEnc: string): Promise<void>;
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
  /**
   * Le chiffré dont `token` a été tiré (`waba_credentials.business_token_enc`), `null` pour le token global. C'est
   * lui qui désigne le jeton à invalider sur une erreur d'auth, jamais « le jeton actuel du WABA ».
   */
  chiffre: string | null;
}

/**
 * Résout le token d'un tenant, avec un cache court par WABA (déchiffrer à chaque message coûte). Un WABA sans
 * credentials -> token global ; un WABA 'invalid' -> TokenInvalidError ; sinon déchiffrement.
 */
export class MetaCredentialsResolver {
  private readonly cache = new Map<string, { token: string; chiffre: string; at: number }>();
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(private readonly deps: CredentialsResolverDeps) {
    this.ttl = deps.cacheTtlMs ?? 5 * 60 * 1000;
    this.now = deps.now ?? ((): number => Date.now());
  }

  async resolveForTenant(tenantId: string): Promise<ResolvedToken> {
    const wabaId = await this.deps.getWabaIdForTenant(tenantId);
    if (!wabaId) return { token: this.deps.fallbackToken, wabaId: null, chiffre: null };
    return this.resolveForWaba(wabaId);
  }

  async resolveForWaba(wabaId: string): Promise<ResolvedToken> {
    const cached = this.cache.get(wabaId);
    if (cached && this.now() - cached.at < this.ttl) return { token: cached.token, wabaId, chiffre: cached.chiffre };

    const cred = await this.deps.credentials.getCredentialsByWaba(wabaId);
    if (!cred) return { token: this.deps.fallbackToken, wabaId: null, chiffre: null }; // pas de credentials propres
    if (cred.tokenStatus === 'invalid') throw new TokenInvalidError(wabaId);

    const token = this.deps.decrypt(cred.businessTokenEnc);
    this.cache.set(wabaId, { token, chiffre: cred.businessTokenEnc, at: this.now() });
    return { token, wabaId, chiffre: cred.businessTokenEnc };
  }

  /**
   * Invalide le token qui a échoué et vide le cache de CETTE copie (sinon le token mort resterait servi, et après une
   * reconnexion le jeton neuf ne serait lu qu'à l'expiration du cache). Le marquage en base ne touche que ce
   * chiffré-là : si le WABA a été reconnecté entre-temps, le jeton neuf reste actif. Best-effort : un échec de
   * `markTokenInvalid` est avalé pour ne pas masquer l'erreur Meta d'origine, que l'appelant relance.
   */
  async invalidate(wabaId: string, chiffre: string): Promise<void> {
    this.cache.delete(wabaId);
    try {
      await this.deps.credentials.markTokenInvalid(wabaId, chiffre);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`markTokenInvalid ignoré pour ${wabaId}:`, messageDe(err));
    }
  }

  /**
   * À appeler dans un catch d'appel Meta, avec la résolution qui a servi à l'appel : si c'est une erreur d'auth et
   * qu'un jeton propre à un WABA est en cause, l'invalide.
   */
  async onError(err: unknown, resolu: Pick<ResolvedToken, 'wabaId' | 'chiffre'>): Promise<void> {
    if (resolu.wabaId && resolu.chiffre !== null && isMetaAuthError(err)) await this.invalidate(resolu.wabaId, resolu.chiffre);
  }
}
