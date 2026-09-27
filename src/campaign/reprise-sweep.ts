import { campaignJobExpireSeconds, resolveRatePerMinute, SANS_PLAFOND } from './pacing';

/**
 * Balayage de reprise après une pause de débit : une campagne qui a touché un plafond de cadence Meta repart
 * d'elle-même à l'échéance.
 *
 * Il ne reprend que les pauses de débit. Une pause de qualité (131048) n'a pas d'échéance : Meta juge alors le
 * numéro, pas la cadence, et relancer sans rien changer aggrave le problème. Cette décision reste humaine.
 *
 * La réclamation est atomique côté store (`update ... returning`) : deux balayages concurrents ne reprennent
 * pas la même campagne.
 */
export interface RepriseSweepDeps {
  /** Reprend en base les campagnes dues (atomique) et rend celles réellement reprises. */
  reprendreDues(): Promise<Array<{ id: string; tenantId: string }>>;
  /** Dimensionnement du run, pour l'expiration du job. `null` = campagne disparue depuis la reprise. */
  getRunSizing(campaignId: string): Promise<{ ratePerMinute: number | null; pendingCount: number } | null>;
  /** Enfile le run. `tenantId` porte le groupe de la file : sans lui, une reprise échapperait au plafond de
   *  concurrence par espace. */
  enqueueRun(campaignId: string, tenantId: string, expireInSeconds: number): Promise<void>;
  defaultRatePerMinute?: number;
  /**
   * Le plus bas des plafonds de canal, pour estimer une durée sans connaître le canal. Absent (tests) -> aucun
   * plafond. Le frein réel est posé par `run-job`, qui lit le canal sur la campagne.
   */
  plafondLePlusBas?: number;
  /** Échec sur une campagne. Le balayage continue ; sans cette remontée, elle resterait `running` sans run. */
  onError?: (msg: string, err: unknown) => void;
}

/**
 * Reprend les campagnes dues et enfile leur run. Rend le nombre de campagnes réellement relancées.
 *
 * L'ordre est l'inverse du balayage des campagnes programmées : ici la reprise en base réclame la ligne et doit
 * venir d'abord, sinon deux balayages enfileraient deux runs. Un échec d'enfilement laisse alors une campagne
 * `running` sans run, que le balayage de reprise après gel rattrape à la minute suivante.
 */
export async function runCampaignRepriseSweep(deps: RepriseSweepDeps): Promise<number> {
  const reprises = await deps.reprendreDues();
  let relancees = 0;
  for (const c of reprises) {
    try {
      const sizing = await deps.getRunSizing(c.id);
      // Campagne disparue entre la reprise et ici : rien à enfiler, et rien d'anormal.
      if (sizing === null) continue;
      await deps.enqueueRun(
        c.id,
        c.tenantId,
        campaignJobExpireSeconds(sizing.pendingCount, resolveRatePerMinute(sizing.ratePerMinute, deps.defaultRatePerMinute ?? 0, deps.plafondLePlusBas ?? SANS_PLAFOND)),
      );
      relancees += 1;
    } catch (err) {
      deps.onError?.(`reprise-sweep: échec sur la campagne ${c.id}`, err);
    }
  }
  return relancees;
}
