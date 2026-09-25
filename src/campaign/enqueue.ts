import { campaignJobExpireSeconds, plafondLePlusBas, resolveRatePerMinute } from './pacing';
import type { Queue } from '../queue/queue';

/**
 * Enfile un run de campagne. `expireInSeconds` dimensionné sur le travail réel (nb destinataires / débit)
 * pour qu'un run throttlé long n'expire pas et ne soit pas rejoué en parallèle.
 *
 * ⚠️ Deux enfilements concurrents pour la même campagne empilent DEUX jobs, et les deux tourneront. Ce
 * fichier a longtemps prétendu l'inverse, sur la foi d'un `singletonKey` qui ne dédupliquait rien (cf.
 * `Queue.enqueue`). Le seul garde-fou est le claim atomique par destinataire : personne ne reçoit deux fois,
 * mais chaque run a SON limiteur de débit en mémoire, donc N runs concurrents envoient à N fois le débit
 * annoncé.
 */
export async function enqueueCampaignRun(
  queue: Queue,
  lancement: { campaignId: string; tenantId: string; pendingCount: number; resolvedRatePerMinute: number | null },
): Promise<void> {
  // `resolvedRatePerMinute` = le débit DÉJÀ résolu par l'appelant (resolveRatePerMinute) : rate de la campagne
  // sinon défaut serveur. pacing doit voir ce même débit que celui qu'appliquera run-job (sinon rejeu parallèle).
  const expireInSeconds = campaignJobExpireSeconds(lancement.pendingCount, lancement.resolvedRatePerMinute);
  // 🔴 `groupId` = l'ESPACE, et c'est ce qui rend la concurrence équitable (lot 5). Le worker plafonne la
  // file à un run par groupe : un client qui lance quatre campagnes n'occupe donc pas les quatre places et
  // n'affame personne. Un objet plutôt que quatre paramètres positionnels : à ce nombre, on finit par en
  // inverser deux, et une inversion entre `pendingCount` et le débit ne se voit que sur une campagne longue.
  await queue.enqueue('campaign-run', { campaignId: lancement.campaignId }, { expireInSeconds, groupId: lancement.tenantId });
}

/**
 * Le RELANCEUR d'un process (worker ou API) : il enfile le run d'une campagne à partir de son débit STOCKÉ
 * (`null` = défaut du serveur), résolu sur la configuration (défaut et plafond du canal le plus bas), donc au
 * débit exact qu'appliquera le run. Chaque appelant dit combien de destinataires attendent : c'est ce qui
 * dimensionne l'expiration du job.
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
