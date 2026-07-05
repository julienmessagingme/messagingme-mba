import type { CampaignCategory, QualityRating, GuardrailThresholds } from './types';

export interface OptInContact {
  optInStatus: 'opted_in' | 'opted_out' | 'unknown';
}

/**
 * Un opt-out explicite bloque TOUT (marketing comme utility). Sinon : marketing exige un
 * opt-in explicite ; utility passe (fenêtre de service).
 */
export function optInAllows(category: CampaignCategory, contact: OptInContact): boolean {
  if (contact.optInStatus === 'opted_out') return false;
  if (category === 'utility') return true;
  return contact.optInStatus === 'opted_in';
}

/** Bloque si un envoi précédent au même contact date de moins de `windowMs`. */
export function frequencyAllows(lastSentAtMs: number | null, nowMs: number, windowMs: number): boolean {
  if (lastSentAtMs === null) return true;
  return nowMs - lastSentAtMs >= windowMs;
}

/**
 * Décide de mettre la campagne en pause selon la santé du numéro :
 * quality rating RED, ou taux d'échec au-delà du seuil (après un minimum d'envois).
 */
export function qualityGate(
  state: { rating: QualityRating; sent: number; failed: number },
  t: GuardrailThresholds,
): { pause: boolean; reason?: string } {
  if (state.rating === 'RED') return { pause: true, reason: 'quality rating RED' };
  const total = state.sent + state.failed;
  if (total >= t.minSendsForFailureCheck) {
    const rate = state.failed / total;
    if (rate > t.maxFailureRate) {
      return { pause: true, reason: `taux d'échec ${Math.round(rate * 100)}% > seuil` };
    }
  }
  return { pause: false };
}

export interface WhatsAppComponent {
  type: 'body';
  parameters: Array<{ type: 'text'; text: string }>;
}

/** Construit les composants d'un template WhatsApp depuis les params résolus. */
export function buildComponents(params: string[]): WhatsAppComponent[] {
  if (params.length === 0) return [];
  return [{ type: 'body', parameters: params.map((text) => ({ type: 'text' as const, text })) }];
}
