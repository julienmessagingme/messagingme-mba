import { campaignJobExpireSeconds } from './pacing';
import type { Queue } from '../queue/queue';

/**
 * Enfile un run de campagne. `singletonKey=campaignId` : deux enfilements concurrents pour la même campagne
 * n'empilent pas deux jobs (le claim par destinataire reste le garde-fou primaire). `expireInSeconds`
 * dimensionné sur le travail réel (nb destinataires / débit) pour qu'un run throttlé long n'expire pas et
 * ne soit pas rejoué en parallèle.
 */
export async function enqueueCampaignRun(queue: Queue, campaignId: string, pendingCount: number, ratePerMinute: number | null): Promise<void> {
  const expireInSeconds = campaignJobExpireSeconds(pendingCount, ratePerMinute);
  await queue.enqueue('campaign-run', { campaignId }, { singletonKey: campaignId, expireInSeconds });
}
