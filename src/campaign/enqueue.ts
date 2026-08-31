import { campaignJobExpireSeconds } from './pacing';
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
export async function enqueueCampaignRun(queue: Queue, campaignId: string, pendingCount: number, resolvedRatePerMinute: number | null): Promise<void> {
  // `resolvedRatePerMinute` = le débit DÉJÀ résolu par l'appelant (resolveRatePerMinute) : rate de la campagne
  // sinon défaut serveur. pacing doit voir ce même débit que celui qu'appliquera run-job (sinon rejeu parallèle).
  const expireInSeconds = campaignJobExpireSeconds(pendingCount, resolvedRatePerMinute);
  await queue.enqueue('campaign-run', { campaignId }, { expireInSeconds });
}
