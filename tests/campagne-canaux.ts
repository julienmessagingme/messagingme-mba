import { runCampaign, type EngineDeps, type RateGate } from '../src/campaign/engine';
import type { CampaignSender } from '../src/campaign/sender';
import type { Campaign, RunReport } from '../src/campaign/types';

/**
 * Les deux FORMES COURTES que les faux de test posent encore : un sender de canal et un frein, pour LE canal
 * de la campagne. Le moteur les acceptait lui-même jusqu'à l'audit ponytail du 2026-09-25 ; seuls les tests
 * les empruntaient (`run-job` construit toujours la table), alors la conversion vit ici.
 */
export type DepsMoteurDeTest = Omit<EngineDeps, 'canaux'> & {
  canaux?: EngineDeps['canaux'];
  channelSender?: CampaignSender;
  rateLimiter?: RateGate;
};

/**
 * `runCampaign` avec la table de canaux que le moteur fabriquait quand `canaux` manquait : UNE entrée, celle du
 * canal de la campagne, avec le sender de canal et le frein s'ils sont posés, et le numéro de la campagne.
 * Une table fournie par le test passe telle quelle, et les formes courtes sont alors ignorées, comme avant.
 */
export function lancerCampagne(campaign: Campaign, deps: DepsMoteurDeTest): Promise<RunReport> {
  const { channelSender, rateLimiter, canaux, ...reste } = deps;
  return runCampaign(campaign, {
    ...reste,
    canaux: canaux ?? {
      [campaign.channel ?? 'whatsapp']: {
        ...(channelSender ? { sender: channelSender } : {}),
        ...(rateLimiter ? { rateLimiter } : {}),
        phoneNumberId: campaign.phoneNumberId,
      },
    },
  });
}
