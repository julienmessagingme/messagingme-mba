import { cacheCourt } from '../lib/cache-court';
import type { QualityRating } from './types';

/**
 * La note de qualité du numéro, lue une fois par durée de vie et pas une fois par destinataire (le moteur
 * la demande dans sa boucle d'envoi).
 *
 * Le cache ne désarme pas la pause au rouge (`qualityGate`) : la colonne n'est rafraîchie que par le
 * balayage `statut-numeros` (`PHONE_STATUS_SWEEP_INTERVAL_MS`, vingt minutes par défaut). Si la qualité
 * arrivait un jour par un webhook Meta, ce cache devrait sauter.
 */

/** Durée de vie, très en dessous de la cadence du balayage : le cache ne retarde pas une note au rouge. */
export const NOTE_QUALITE_TTL_MS = 30_000;

export function creerNoteDeQualite(
  lire: (phoneNumberId: string) => Promise<QualityRating>,
  ttlMs: number = NOTE_QUALITE_TTL_MS,
  maintenant: () => number = Date.now,
): (phoneNumberId: string) => Promise<QualityRating> {
  const cache = cacheCourt<QualityRating>(ttlMs, maintenant);
  return (phoneNumberId: string) => cache.lire(phoneNumberId, () => lire(phoneNumberId));
}
