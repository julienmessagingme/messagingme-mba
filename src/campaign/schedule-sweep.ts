import { campaignJobExpireSeconds, resolveRatePerMinute } from './pacing';

export interface ScheduleSweepDeps {
  /** Campagnes programmées DUES (scheduled_at <= maintenant) + leur dimensionnement de run. */
  listDue(): Promise<Array<{ id: string; tenantId: string; ratePerMinute: number | null; pendingCount: number }>>;
  /** Enfile le run avec le timeout dimensionné. ⚠️ NON idempotent : deux appels = deux jobs (cf. `enqueue.ts`). */
  /** `tenantId` porte le GROUPE de la file (lot 5) : sans lui, une campagne programmée échapperait au
   *  plafond de concurrence par espace, et un client pourrait occuper toute la file en programmant. */
  enqueueRun(campaignId: string, tenantId: string, expireInSeconds: number): Promise<void>;
  /** Passe la campagne 'scheduled' -> 'running' (garde status, anti-re-liste). Idempotent. */
  markRunning(campaignId: string): Promise<boolean>;
  /** Débit par défaut (msg/min, 0 = opt-out) des campagnes sans ratePerMinute. MÊME valeur qu'au worker et à
   *  la route campagnes, pour que l'estimation d'expiration voie le débit réel qu'appliquera run-job. Absent
   *  (tests) -> 0 = opt-out. */
  defaultRatePerMinute?: number;
  /** Échec sur UNE campagne. Le balayage, lui, RÉUSSIT (il continue), donc le catch du worker ne le voit
   *  jamais : sans cette remontée, la campagne reste `scheduled` et se retente toutes les 60 s à vie, sans
   *  qu'aucune alerte ne parte. Même signature que `AnalysisSweepDeps.onError`. Absent (tests) -> silencieux. */
  onError?: (msg: string, err: unknown) => void;
}

/**
 * Balaie les campagnes programmées dues et lance leur run. Pattern miroir du sweeper d'analyse.
 *
 * ENQUEUE PUIS markRunning (dans cet ordre) : si l'enqueue échoue, la campagne RESTE 'scheduled' et sera
 * reprise au tour suivant (pas de statut 'running' orphelin sans job). Et le run-job repasse lui-même la
 * campagne en 'running' à son démarrage : même si markRunning échoue, rien ne se bloque.
 *
 * ⚠️ Ce qui empêche le double-run, c'est `markRunning` (garde sur le statut, la campagne cesse d'être listée),
 * PAS l'enfilement : l'enqueue n'est pas idempotent, deux appels empilent deux jobs qui tourneront tous les
 * deux. Le commentaire d'origine créditait un `singletonKey` qui ne dédupliquait rien (cf. `Queue.enqueue`).
 * Le claim atomique par destinataire garantit qu'aucun contact ne reçoit deux fois, il ne garantit pas le
 * débit. Un échec par campagne n'interrompt pas le balayage. Retourne le nombre de campagnes enfilées.
 */
export async function runCampaignScheduleSweep(deps: ScheduleSweepDeps): Promise<number> {
  const due = await deps.listDue();
  let launched = 0;
  for (const c of due) {
    try {
      await deps.enqueueRun(
        c.id,
        c.tenantId,
        campaignJobExpireSeconds(c.pendingCount, resolveRatePerMinute(c.ratePerMinute, deps.defaultRatePerMinute ?? 0)),
      );
      await deps.markRunning(c.id);
      launched += 1;
    } catch (err) {
      deps.onError?.(`schedule-sweep: échec sur la campagne ${c.id}`, err);
    }
  }
  return launched;
}
