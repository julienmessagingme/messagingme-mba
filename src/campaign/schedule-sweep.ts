import { campaignJobExpireSeconds, resolveRatePerMinute, SANS_PLAFOND } from './pacing';

export interface ScheduleSweepDeps {
  /** Campagnes programmées dues (scheduled_at <= maintenant) et leur dimensionnement de run. */
  listDue(): Promise<Array<{ id: string; tenantId: string; ratePerMinute: number | null; pendingCount: number }>>;
  /** Enfile le run avec le timeout dimensionné. Non idempotent : deux appels = deux jobs. `tenantId` porte le
   *  groupe de la file : sans lui, une campagne programmée échapperait au plafond de concurrence par espace. */
  enqueueRun(campaignId: string, tenantId: string, expireInSeconds: number): Promise<void>;
  /** Passe la campagne 'scheduled' -> 'running' (garde status, anti-re-liste). Idempotent. */
  markRunning(campaignId: string): Promise<boolean>;
  /** Débit par défaut (msg/min, 0 = opt-out) des campagnes sans ratePerMinute : la même valeur qu'au worker,
   *  pour que l'expiration estimée voie le débit réel de run-job. Absent (tests) -> 0. */
  defaultRatePerMinute?: number;
  /**
   * Le plus bas des plafonds de canal, pour estimer une durée sans connaître le canal. Absent (tests) -> aucun
   * plafond. Le frein réel est posé par `run-job`, qui lit le canal sur la campagne.
   */
  plafondLePlusBas?: number;
  /** Échec sur une campagne. Le balayage continue, donc le catch du worker ne le voit jamais : sans cette
   *  remontée, la campagne resterait `scheduled` et se retenterait à vie sans alerte. */
  onError?: (msg: string, err: unknown) => void;
}

/**
 * Balaie les campagnes programmées dues et lance leur run. Rend le nombre de campagnes enfilées.
 *
 * Enqueue puis markRunning, dans cet ordre : si l'enqueue échoue, la campagne reste `scheduled` et sera reprise
 * au tour suivant. Le run-job repasse lui-même la campagne en `running`, donc un échec de markRunning ne bloque
 * rien.
 *
 * Le double-run est empêché par `markRunning` (garde sur le statut, la campagne cesse d'être listée), pas par
 * l'enfilement, qui n'est pas idempotent. Un échec par campagne n'interrompt pas le balayage.
 */
export async function runCampaignScheduleSweep(deps: ScheduleSweepDeps): Promise<number> {
  const due = await deps.listDue();
  let launched = 0;
  for (const c of due) {
    try {
      await deps.enqueueRun(
        c.id,
        c.tenantId,
        campaignJobExpireSeconds(c.pendingCount, resolveRatePerMinute(c.ratePerMinute, deps.defaultRatePerMinute ?? 0, deps.plafondLePlusBas ?? SANS_PLAFOND)),
      );
      await deps.markRunning(c.id);
      launched += 1;
    } catch (err) {
      deps.onError?.(`schedule-sweep: échec sur la campagne ${c.id}`, err);
    }
  }
  return launched;
}
