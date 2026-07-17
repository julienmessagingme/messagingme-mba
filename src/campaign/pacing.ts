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
 */
export function campaignJobExpireSeconds(recipientCount: number, ratePerMinute: number | null): number {
  const n = Math.max(0, Math.floor(recipientCount));
  // Sans throttle (rate null), le run part au max (latence Meta) : on prend un PLANCHER de débit prudent
  // (30/min) pour l'estimation, ce qui donne un timeout généreux même si Meta nous ralentit.
  const effectiveRate = ratePerMinute && ratePerMinute > 0 ? ratePerMinute : 30;
  const durationSec = Math.ceil((n / effectiveRate) * 60);
  // Plancher 15 min (petites campagnes) ; sinon 1,5x la durée estimée + 10 min de marge.
  return Math.max(900, Math.ceil(durationSec * 1.5) + 600);
}
