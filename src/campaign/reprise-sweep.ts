import { campaignJobExpireSeconds, resolveRatePerMinute } from './pacing';

/**
 * BALAYAGE DE REPRISE APRÈS UNE PAUSE DE DÉBIT (migration 0103).
 *
 * Une campagne qui touche un plafond de cadence Meta se met en pause d'elle-même, sans perdre personne.
 * Jusqu'ici, RIEN ne la repartait : il fallait un clic. Le texte affiché à l'opérateur promettait pourtant
 * une reprise automatique. Ce balayage rend cette phrase vraie.
 *
 * 🔴 IL NE REPREND QUE LES PAUSES DE DÉBIT. Une pause de QUALITÉ (131048) n'a pas d'échéance et n'entre pas
 * ici : Meta juge alors le numéro, pas la cadence, et relancer sans rien changer aggrave le problème. Cette
 * décision-là reste humaine, et c'est le point le plus important de tout le lot.
 *
 * La réclamation est ATOMIQUE côté store (`update ... returning` sur les lignes dues) : deux balayages
 * concurrents ne peuvent pas reprendre la même campagne ni enfiler deux runs pour elle.
 */
export interface RepriseSweepDeps {
  /** Reprend en base les campagnes dues (atomique) et rend celles réellement reprises. */
  reprendreDues(): Promise<Array<{ id: string; tenantId: string }>>;
  /** Dimensionnement du run, pour l'expiration du job. `null` = campagne disparue depuis la reprise. */
  getRunSizing(campaignId: string): Promise<{ ratePerMinute: number | null; pendingCount: number } | null>;
  /** Enfile le run. `tenantId` porte le GROUPE de la file : sans lui, une reprise échapperait au plafond de
   *  concurrence par espace, et un client qui touche souvent le plafond occuperait toute la file. */
  enqueueRun(campaignId: string, tenantId: string, expireInSeconds: number): Promise<void>;
  defaultRatePerMinute?: number;
  /** Échec sur UNE campagne. Le balayage, lui, continue : une campagne qui n'a pas pu être enfilée ne doit
   *  pas empêcher les autres de repartir. Sans cette remontée, elle resterait `running` sans run. */
  onError?: (msg: string, err: unknown) => void;
}

/**
 * Reprend les campagnes dues et enfile leur run. Rend le nombre de campagnes réellement relancées.
 *
 * ⚠️ L'ORDRE est l'inverse de celui du balayage des campagnes programmées, et c'est voulu. Là-bas on enfile
 * PUIS on marque, pour qu'un échec d'enfilement laisse la campagne `scheduled` et reprise au tour suivant.
 * Ici la reprise en base est ce qui RÉCLAME la ligne : elle doit venir d'abord, sinon deux balayages
 * enfileraient deux runs pour la même campagne. La contrepartie est qu'un échec d'enfilement laisse une
 * campagne `running` sans run, et c'est exactement le cas que le balayage de reprise après gel (R4) attrape
 * déjà, à la minute suivante. On échange donc un double envoi possible contre un retard d'une minute.
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
        campaignJobExpireSeconds(sizing.pendingCount, resolveRatePerMinute(sizing.ratePerMinute, deps.defaultRatePerMinute ?? 0)),
      );
      relancees += 1;
    } catch (err) {
      deps.onError?.(`reprise-sweep: échec sur la campagne ${c.id}`, err);
    }
  }
  return relancees;
}
