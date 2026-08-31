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
 * Codes de PLAFOND DU NUMÉRO : Meta refuse temporairement, et son refus vise le numéro émetteur, pas le
 * destinataire. `130429` = plafond de débit, `131048` = plafond lié à la qualité (« spam rate limit »).
 *
 * 🔴 Ils n'étaient dans AUCUNE des deux listes ci-dessous, donc traités par le défaut « 4xx sans code connu =
 * terminal » : un plafond ne ralentissait pas une campagne, il faisait échouer DÉFINITIVEMENT le destinataire
 * en cours, puis le suivant, puis les 4 998 autres. Une campagne pouvait ainsi brûler toute son audience sur
 * une limite temporaire, sans qu'aucun de ces contacts ne soit joignable à nouveau sans intervention.
 *
 * Ils sont désormais rejouables (c'est la vérité : l'attente les résout), et le moteur de campagne les
 * reconnaît EN PLUS comme un plafond de numéro, pour mettre la campagne en pause au lieu d'insister
 * destinataire par destinataire. Les deux lectures sont complémentaires, cf. `estPlafondNumero`.
 *
 * ⚠️ `131056` reste à part : c'est un plafond de la PAIRE (trop de messages entre ce numéro et CE contact).
 * Rejouable, mais il ne dit rien du numéro, donc il ne doit pas mettre la campagne en pause.
 */
export const CODES_PLAFOND_NUMERO = new Set<number>([130429, 131048]);

/**
 * Cette erreur dit-elle que le NUMÉRO est plafonné ? Le moteur de campagne s'en sert pour rendre le
 * destinataire à la file et mettre la campagne en pause, plutôt que de le compter en échec : il n'a rien fait
 * de mal, et le suivant échouerait pour la même raison.
 */
export function estPlafondNumero(err: unknown): boolean {
  return err instanceof MetaApiError && err.code !== undefined && CODES_PLAFOND_NUMERO.has(err.code);
}

// Premier jeu de codes (extensible, à affiner avec la doc Meta live).
// Transitoires : rejouables tels quels.
const RETRYABLE_CODES = new Set<number>([1, 2, 4, 130429, 131016, 131026, 131048, 131056, 133016]);
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
