export interface MetaErrorBody {
  code?: number;
  error_subcode?: number;
  type?: string;
  message?: string;
}

// Premier jeu de codes (extensible, à affiner avec la doc Meta live).
// Transitoires : rejouables tels quels.
const RETRYABLE_CODES = new Set<number>([1, 2, 4, 131016, 131026, 131056, 133016]);
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

  constructor(httpStatus: number, body: MetaErrorBody | null, retryAfterMs?: number) {
    super(body?.message ?? `Meta API error (HTTP ${httpStatus})`);
    this.name = 'MetaApiError';
    this.httpStatus = httpStatus;
    this.code = body?.code;
    this.subcode = body?.error_subcode;
    this.type = body?.type;
    this.retryable = classify(httpStatus, body);
    this.retryAfterMs = retryAfterMs;
  }
}
