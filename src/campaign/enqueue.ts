import { campaignJobExpireSeconds, plafondLePlusBas, resolveRatePerMinute } from './pacing';
import type { Queue } from '../queue/queue';

/**
 * Enfile un run de campagne. `expireInSeconds` est dimensionné sur le travail réel (destinataires / débit)
 * pour qu'un run long n'expire pas et ne soit pas rejoué en parallèle.
 *
 * Deux enfilements concurrents pour la même campagne font deux jobs qui tournent (la file ne déduplique
 * rien). Le claim atomique par destinataire empêche le double envoi, mais chaque run a son limiteur de
 * débit : N runs concurrents envoient à N fois le débit annoncé.
 */
export async function enqueueCampaignRun(
  queue: Queue,
  lancement: { campaignId: string; tenantId: string; pendingCount: number; resolvedRatePerMinute: number | null },
): Promise<void> {
  // Le débit déjà résolu par l'appelant : pacing doit voir le même que run-job, sinon rejeu parallèle.
  const expireInSeconds = campaignJobExpireSeconds(lancement.pendingCount, lancement.resolvedRatePerMinute);
  // `groupId` = l'espace : le worker plafonne la file à un run par groupe, donc un client qui lance
  // plusieurs campagnes n'affame pas les autres.
  await queue.enqueue('campaign-run', { campaignId: lancement.campaignId }, { expireInSeconds, groupId: lancement.tenantId });
}

/**
 * Le relanceur d'un process (worker ou API) : enfile le run à partir du débit stocké (`null` = défaut du
 * serveur), résolu comme le fera le run. `pendingCount` dimensionne l'expiration du job.
 */
export function relanceurDeCampagnes(
  queue: Queue,
  cfg: { CAMPAIGN_DEFAULT_RATE_PER_MINUTE: number; PHONE_RATE_PER_MINUTE_MAX: number; RCS_RATE_PER_MINUTE_MAX: number },
): (c: { campaignId: string; tenantId: string; pendingCount: number; ratePerMinute: number | null }) => Promise<void> {
  return (c) => enqueueCampaignRun(queue, {
    campaignId: c.campaignId,
    tenantId: c.tenantId,
    pendingCount: c.pendingCount,
    resolvedRatePerMinute: resolveRatePerMinute(c.ratePerMinute, cfg.CAMPAIGN_DEFAULT_RATE_PER_MINUTE, plafondLePlusBas(cfg)),
  });
}
