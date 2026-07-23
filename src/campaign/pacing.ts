/**
 * Débit EFFECTIF d'un run de campagne : le rate posé sur la campagne prime ; à défaut, le défaut serveur.
 * Renvoie un nombre où <= 0 signifie « aucun frein » (opt-out). Un `stored` <= 0 est traité comme non posé.
 *
 * Utilisé aux DEUX endroits qui doivent voir le MÊME débit : le throttle réel (run-job) et l'estimation de
 * durée (campaignJobExpireSeconds). Les résoudre séparément désaligne pacing et run-job -> expireInSeconds
 * sous-dimensionné pour un défaut < 30 -> pg-boss rejoue le job en parallèle. D'où ce point unique.
 */
export function resolveRatePerMinute(stored: number | null, serverDefault: number): number {
  if (stored && stored > 0) return stored;
  return serverDefault > 0 ? serverDefault : 0;
}

/**
 * Dimensionnement du timeout (expireInSeconds) d'un job `campaign-run`.
 *
 * Un run de campagne throttlé (débit ajustable) tourne EN LIGNE, séquentiellement, dans un seul job pg-boss.
 * Si le job dépasse son `expireInSeconds`, pg-boss le considère expiré et le REJOUE en parallèle -> deux runs
 * de la MÊME campagne tournent en même temps : le débit réel double (défait le slider bas, risque réputation
 * du numéro) et un run peut marquer la campagne `completed` alors que l'autre envoie encore. Un timeout FIXE
 * ne suffit pas (7200 s ne couvre que ~120 destinataires à 1/min). On dimensionne donc le timeout PAR JOB sur
 * le travail réel : durée estimée = destinataires / débit, + marge. Généreux par construction (jamais
 * sous-dimensionné = jamais de rejeu parasite) ; le claim atomique reste le garde anti-double-envoi.
 *
 * ⚠️ `resolvedRatePerMinute` DOIT être le débit résolu (resolveRatePerMinute), pas le rate brut de la
 * campagne : sinon un défaut serveur < 30 ferait tourner run-job plus lentement que ce que pacing estime.
 */
export function campaignJobExpireSeconds(recipientCount: number, resolvedRatePerMinute: number | null): number {
  const n = Math.max(0, Math.floor(recipientCount));
  // Rate résolu <= 0 = opt-out (aucun throttle) : le run part au max (latence Meta), on prend un PLANCHER
  // prudent de 30/min pour l'estimation, ce qui donne un timeout généreux même si Meta nous ralentit. Le
  // plancher ne s'applique QU'À l'opt-out, jamais par-dessus un débit positif < 30 (qui, lui, est plus lent).
  const effectiveRate = resolvedRatePerMinute && resolvedRatePerMinute > 0 ? resolvedRatePerMinute : 30;
  const durationSec = Math.ceil((n / effectiveRate) * 60);
  // Plancher 15 min (petites campagnes) ; sinon 1,5x la durée estimée + 10 min de marge.
  return Math.max(900, Math.ceil(durationSec * 1.5) + 600);
}
