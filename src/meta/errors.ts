export interface MetaErrorBody {
  code?: number;
  error_subcode?: number;
  type?: string;
  message?: string;
  /** Titre lisible destiné à l'utilisateur (souvent plus utile que `message` = « Invalid parameter »). */
  error_user_title?: string;
  /** Message lisible destiné à l'utilisateur (ex. « Les exemples de modèles ne peuvent pas être supprimés »). */
  error_user_msg?: string;
}

/**
 * Codes de plafond du numéro : Meta refuse temporairement, et son refus vise le numéro émetteur, pas le
 * destinataire. `130429` = plafond de débit, `131048` = plafond lié à la qualité.
 *
 * Rejouables, et reconnus en plus par le moteur de campagne comme un plafond de numéro, pour mettre la campagne
 * en pause au lieu de faire échouer définitivement chaque destinataire (cf. `estPlafondNumero`).
 * `131056` reste à part : plafond de la paire (ce numéro et ce contact), rejouable mais sans pause de campagne.
 */
export const CODES_PLAFOND_NUMERO = new Set<number>([130429, 131048]);

/**
 * Cette erreur dit-elle que le numéro est plafonné ? Le moteur de campagne s'en sert pour rendre le
 * destinataire à la file et mettre la campagne en pause, plutôt que de le compter en échec : il n'a rien fait
 * de mal, et le suivant échouerait pour la même raison.
 */
export function estPlafondNumero(err: unknown): boolean {
  if (!(err instanceof MetaApiError)) return false;
  if (err.code !== undefined && CODES_PLAFOND_NUMERO.has(err.code)) return true;
  // Un 429 est un plafond même sans code connu : « trop de requêtes » parle de nous, jamais du destinataire,
  // qui finirait sinon en échec et injoignable sans intervention.
  return err.httpStatus === 429;
}

/**
 * Pourquoi le numéro est plafonné, ce qui décide si la campagne peut repartir seule. Une limite de cadence
 * retombe d'elle-même. Une qualité dégradée (131048) est un jugement de Meta sur le numéro : relancer sans rien
 * changer peut coûter le numéro, donc une pause qualité n'est jamais levée par une machine.
 * `undefined` quand ce n'est pas un plafond.
 */
export type RaisonDePause = 'debit' | 'qualite';

export function raisonDePause(err: unknown): RaisonDePause | undefined {
  if (!estPlafondNumero(err)) return undefined;
  return err instanceof MetaApiError && err.code === 131048 ? 'qualite' : 'debit';
}

// Transitoires : rejouables tels quels.
// 131026 n'y est pas : Meta dit que le numéro n'est pas sur WhatsApp ou que la personne n'a pas accepté les
// conditions, rien qui change dans la seconde. Son rattrapage vit au niveau campagne. `classify` sert à
// `withRetry`, qui enveloppe tous les envois (Inbox, agent, scénario, campagne) : la règle vaut partout.
const RETRYABLE_CODES = new Set<number>([1, 2, 4, 130429, 131016, 131048, 131056, 133016]);
// Terminaux : rejouer ne sert à rien (param invalide, hors fenêtre, marché bloqué, auth).
const TERMINAL_CODES = new Set<number>([100, 190, 131047, 131049, 131051, 131052, 131053]);

/** Décide si une réponse d'erreur Meta est rejouable. */
export function classify(httpStatus: number, body: MetaErrorBody | null): boolean {
  if (httpStatus === 429) return true; // rate limit
  if (httpStatus === 408 || httpStatus === 425) return true; // timeout / too early : transitoires
  if (httpStatus >= 500) return true; // erreur serveur transitoire
  const code = body?.code;
  if (code !== undefined) {
    if (RETRYABLE_CODES.has(code)) return true;
    if (TERMINAL_CODES.has(code)) return false;
  }
  // Par défaut, un 4xx sans code connu est terminal (prudent : on ne matraque pas Meta).
  return false;
}

export class MetaApiError extends Error {
  readonly httpStatus: number;
  readonly code: number | undefined;
  readonly subcode: number | undefined;
  readonly type: string | undefined;
  readonly retryable: boolean;
  /** Délai (ms) issu d'un header Retry-After, si présent. */
  readonly retryAfterMs: number | undefined;
  /** Message lisible fourni par Meta (`error_user_msg`/`error_user_title`), à préférer pour l'affichage. */
  readonly userMessage: string | undefined;

  constructor(httpStatus: number, body: MetaErrorBody | null, retryAfterMs?: number) {
    super(body?.message ?? `Meta API error (HTTP ${httpStatus})`);
    this.name = 'MetaApiError';
    this.httpStatus = httpStatus;
    this.code = body?.code;
    this.subcode = body?.error_subcode;
    this.type = body?.type;
    this.retryable = classify(httpStatus, body);
    this.retryAfterMs = retryAfterMs;
    // Meta joint souvent une explication utilisateur bien plus utile que « Invalid parameter ».
    this.userMessage = body?.error_user_msg ?? body?.error_user_title ?? undefined;
  }
}
