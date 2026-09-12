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
  if (!(err instanceof MetaApiError)) return false;
  if (err.code !== undefined && CODES_PLAFOND_NUMERO.has(err.code)) return true;
  // 🔴 UN 429 EST UN PLAFOND, même sans code connu. Angle mort relevé par le contre-audit du 2026-09-01 : un
  // HTTP 429 dont le corps ne porte pas 130429 était rejouable dans le transport, mais n'entrait pas ici.
  // Une fois les tentatives épuisées, il finissait donc en ÉCHEC DU DESTINATAIRE, qui n'y est pour rien et
  // devient injoignable sans intervention, pendant que le suivant échouait à son tour. « Trop de requêtes »
  // ne parle jamais du destinataire, il parle de nous.
  return err.httpStatus === 429;
}

/**
 * POURQUOI le numéro est plafonné, et c'est ce qui décide si la campagne peut repartir toute seule.
 *
 * 🔴 La distinction n'est pas cosmétique. Une limite de CADENCE retombe d'elle-même : la réessayer après un
 * délai est le bon geste. Une QUALITÉ dégradée (131048) est un jugement de Meta sur le numéro : relancer
 * sans rien changer aggrave le problème et peut coûter le numéro. Une pause qualité ne doit donc JAMAIS être
 * levée par une machine.
 *
 * `undefined` quand ce n'est pas un plafond du tout.
 */
export type RaisonDePause = 'debit' | 'qualite';

export function raisonDePause(err: unknown): RaisonDePause | undefined {
  if (!estPlafondNumero(err)) return undefined;
  return err instanceof MetaApiError && err.code === 131048 ? 'qualite' : 'debit';
}

// Premier jeu de codes (extensible, à affiner avec la doc Meta live).
// Transitoires : rejouables tels quels.
// 🔴 131026 N'EST PAS ICI, ET C'EST DÉLIBÉRÉ (2026-09-12). Meta dit textuellement que ce code veut
// dire que le numéro n'est pas un numéro WhatsApp, ou que la personne n'a pas accepté les
// conditions. Aucune de ces causes ne change dans la seconde : le rejouer double les appels sur
// chaque numéro sans WhatsApp, sans aucune chance de succès. Son rattrapage vit au niveau
// campagne (bascule d'étage ou joignabilité mémorisée), pas au niveau transport.
// ⚠️ Ce retrait vaut pour TOUS les chemins d'envoi, pas seulement les campagnes : `classify` ne sert
// qu'à `MetaApiError.retryable`, lu par le seul `withRetry` (`src/meta/http.ts`), qui enveloppe
// `MetaClient.call`, donc l'envoi rapide de l'Inbox, le tour d'agent et le scénario autant que le
// moteur de campagne. C'est voulu : le code veut dire la même chose partout.
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
