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

/** Par où passent les appels d'un compte WhatsApp (`waba_credentials.fournisseur`, migration 0239). */
export type Fournisseur = 'meta' | '360dialog';

/**
 * Le compte passe par 360dialog : sa clé ne parle qu'à `waba-v2.360dialog.io`. Levée par `resolveForTenant` et
 * `resolveForWaba`, que lisent tous ceux qui parlent à Graph : la clé ne leur est JAMAIS rendue, sans quoi un appel
 * Graph partirait avec elle et son 401 l'invaliderait (coupant tous les envois). Seuls les clients qui savent parler à
 * 360dialog la lisent, par `resolvePourEnvoi` (envoi, modèles, Flows, médias). Ce n'est pas une erreur
 * d'authentification : rien n'est invalidé.
 */
export class CompteChez360dialog extends Error {
  constructor(readonly wabaId: string) {
    super(`le compte WhatsApp ${wabaId} passe par 360dialog : aucun appel direct à Meta`);
    this.name = 'CompteChez360dialog';
  }
}

/**
 * Vrai si l'erreur Meta dit un jeton mort : code 190, ou HTTP 401. Règle unique, que `pullFromError` importe.
 *
 * 🔴 JAMAIS LE SEUL TYPE `OAuthException` : Meta le pose sur la plupart de ses refus d'envoi (paramètre refusé 100,
 * paramètres du modèle 132000, quota, refus de la Marketing Messages API 134101...). Le tenir pour une preuve
 * invalidait le jeton d'un espace entier sur un simple refus, et coupait tous ses envois jusqu'à une reconnexion :
 * c'est ce qu'a vécu « Test DIDWA claude code », marqué invalide le 2026-10-05 alors que Meta le disait valide.
 */
export function isMetaAuthError(err: unknown): boolean {
  return err instanceof MetaApiError && (err.code === 190 || err.httpStatus === 401);
}

export interface WabaCredential {
  businessTokenEnc: string;
  tokenStatus: 'active' | 'invalid';
  /** Absent : `meta` (les fixtures d'avant 0239). Le magasin réel le lit toujours. */
  fournisseur?: Fournisseur;
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
/** Une résolution pour l'ENVOI : la clé d'un compte 360dialog y est rendue, avec son fournisseur. */
export interface ResolvedEnvoi extends ResolvedToken {
  fournisseur: Fournisseur;
}

export class MetaCredentialsResolver {
  private readonly cache = new Map<string, { token: string; chiffre: string; fournisseur: Fournisseur; at: number }>();
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(private readonly deps: CredentialsResolverDeps) {
    this.ttl = deps.cacheTtlMs ?? 5 * 60 * 1000;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /** Le jeton Meta d'un espace. 🔴 Lève `CompteChez360dialog` pour un compte 360dialog (voir la classe). */
  async resolveForTenant(tenantId: string): Promise<ResolvedToken> {
    const wabaId = await this.deps.getWabaIdForTenant(tenantId);
    if (!wabaId) return { token: this.deps.fallbackToken, wabaId: null, chiffre: null };
    return this.resolveForWaba(wabaId);
  }

  /** Le jeton Meta d'un compte. 🔴 Lève `CompteChez360dialog` pour un compte 360dialog (voir la classe). */
  async resolveForWaba(wabaId: string): Promise<ResolvedToken> {
    const { fournisseur, ...resolu } = await this.lire(wabaId);
    if (fournisseur === '360dialog') throw new CompteChez360dialog(wabaId);
    return resolu;
  }

  /**
   * La résolution des clients qui savent parler à 360dialog (`MetaClientFactory` : envoi, modèles, Flows) : la seule qui
   * rend une clé 360dialog, avec son fournisseur pour que l'appelant construise le bon client. Sans compte propre : le jeton global, fournisseur `meta`.
   */
  async resolvePourEnvoi(tenantId: string): Promise<ResolvedEnvoi> {
    const wabaId = await this.deps.getWabaIdForTenant(tenantId);
    if (!wabaId) return { token: this.deps.fallbackToken, wabaId: null, chiffre: null, fournisseur: 'meta' };
    return this.lire(wabaId);
  }

  /**
   * La clé 360dialog d'un espace, `null` s'il passe par Meta : l'aiguillage des médias reçus. 🔴 N'échoue jamais : la
   * lecture d'un média d'un espace Meta passait par le jeton global sans lire ses identifiants, et une lecture en échec
   * (jeton invalide, chiffré illisible, base) ne doit pas la casser. `null`, journalisé : le chemin Meta d'avant.
   */
  async cle360dialog(tenantId: string): Promise<string | null> {
    try {
      const r = await this.resolvePourEnvoi(tenantId);
      return r.fournisseur === '360dialog' ? r.token : null;
    } catch (err) {
      // eslint-disable-next-line no-console
      if (!(err instanceof TokenInvalidError)) console.error(`cle360dialog ignorée pour ${tenantId}:`, messageDe(err));
      return null;
    }
  }

  private async lire(wabaId: string): Promise<ResolvedEnvoi> {
    const cached = this.cache.get(wabaId);
    if (cached && this.now() - cached.at < this.ttl) {
      return { token: cached.token, wabaId, chiffre: cached.chiffre, fournisseur: cached.fournisseur };
    }

    const cred = await this.deps.credentials.getCredentialsByWaba(wabaId);
    // Pas de credentials propres : le jeton global, qui ne vaut que chez Meta.
    if (!cred) return { token: this.deps.fallbackToken, wabaId: null, chiffre: null, fournisseur: 'meta' };
    if (cred.tokenStatus === 'invalid') throw new TokenInvalidError(wabaId);

    const token = this.deps.decrypt(cred.businessTokenEnc);
    const fournisseur = cred.fournisseur ?? 'meta';
    this.cache.set(wabaId, { token, chiffre: cred.businessTokenEnc, fournisseur, at: this.now() });
    return { token, wabaId, chiffre: cred.businessTokenEnc, fournisseur };
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
