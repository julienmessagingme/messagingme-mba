import { campaignJobExpireSeconds, resolveRatePerMinute } from './pacing';

export interface ScheduleSweepDeps {
  /** Campagnes programmées DUES (scheduled_at <= maintenant) + leur dimensionnement de run. */
  listDue(): Promise<Array<{ id: string; ratePerMinute: number | null; pendingCount: number }>>;
  /** Enfile le run (singletonKey = campaignId côté impl -> idempotent) avec le timeout dimensionné. */
  enqueueRun(campaignId: string, expireInSeconds: number): Promise<void>;
  /** Passe la campagne 'scheduled' -> 'running' (garde status, anti-re-liste). Idempotent. */
  markRunning(campaignId: string): Promise<boolean>;
  /** Débit par défaut (msg/min, 0 = opt-out) des campagnes sans ratePerMinute. MÊME valeur qu'au worker et à
   *  la route campagnes, pour que l'estimation d'expiration voie le débit réel qu'appliquera run-job. Absent
   *  (tests) -> 0 = opt-out. */
  defaultRatePerMinute?: number;
}

/**
 * Balaie les campagnes programmées dues et lance leur run. Pattern miroir du sweeper d'analyse.
 *
 * ENQUEUE PUIS markRunning (dans cet ordre) : si l'enqueue échoue, la campagne RESTE 'scheduled' et sera
 * reprise au tour suivant (pas de statut 'running' orphelin sans job). L'enqueue est idempotent (singletonKey =
 * campaignId dédup côté file) ET le run-job repasse lui-même la campagne en 'running' à son démarrage : même si
 * markRunning échoue, il n'y a jamais de double-run (le claim atomique par destinataire tranche) ni de blocage.
 * Un échec par campagne n'interrompt pas le balayage. Retourne le nombre de campagnes enfilées.
 */
export async function runCampaignScheduleSweep(deps: ScheduleSweepDeps): Promise<number> {
  const due = await deps.listDue();
  let launched = 0;
  for (const c of due) {
    try {
      await deps.enqueueRun(
        c.id,
        campaignJobExpireSeconds(c.pendingCount, resolveRatePerMinute(c.ratePerMinute, deps.defaultRatePerMinute ?? 0)),
      );
      await deps.markRunning(c.id);
      launched += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`schedule-sweep: échec sur la campagne ${c.id}`, err);
    }
  }
  return launched;
}
