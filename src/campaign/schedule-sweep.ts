import { campaignJobExpireSeconds, resolveRatePerMinute, SANS_PLAFOND } from './pacing';
import type { EstimationCredit } from '../credit-whatsapp/estimation';

export interface ScheduleSweepDeps {
  /** Le dépôt des campagnes. */
  repo: {
    /** Campagnes programmées dues (scheduled_at <= maintenant) et leur dimensionnement de run. */
    listDueScheduled(): Promise<Array<{ id: string; tenantId: string; ratePerMinute: number | null; pendingCount: number }>>;
    /** Passe la campagne 'scheduled' -> 'running' (garde status, anti-re-liste). Idempotent. */
    markScheduledRunning(campaignId: string): Promise<boolean>;
  };
  /** Enfile le run avec le timeout dimensionné. Non idempotent : deux appels = deux jobs. `tenantId` porte le
   *  groupe de la file : sans lui, une campagne programmée échapperait au plafond de concurrence par espace. */
  enqueueRun(campaignId: string, tenantId: string, expireInSeconds: number): Promise<void>;
  /** Débit par défaut (msg/min, 0 = opt-out) des campagnes sans ratePerMinute : la même valeur qu'au worker,
   *  pour que l'expiration estimée voie le débit réel de run-job. Absent (tests) -> 0. */
  defaultRatePerMinute?: number;
  /**
   * Le plus bas des plafonds de canal, pour estimer une durée sans connaître le canal. Absent (tests) -> aucun
   * plafond. Le frein réel est posé par `run-job`, qui lit le canal sur la campagne.
   */
  plafondLePlusBas?: number;
  /**
   * Le Crédit WhatsApp au départ (plan du Crédit WhatsApp, tâche 6) : une campagne programmée dont l'estimation dépasse le
   * solde ne part pas, elle passe en pause `credit_whatsapp_epuise` sans rien envoyer, comme un lancement immédiat est
   * refusé. 🔴 Requis : un câblage qui l'oublierait la laisserait partir jusqu'à la pause à zéro, à moitié envoyée.
   * `pauser` n'écrit la pause que si le solde est encore sous le montant (`pauserCampagneCredit`) : un crédit arrivé
   * entre-temps la laisse due, et elle part au tour suivant.
   */
  creditAuDepart: {
    estimer(tenantId: string, campaignId: string): Promise<EstimationCredit | null>;
    pauser(campaignId: string, tenantId: string, montantMicroEur: number): Promise<boolean>;
  };
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
  const due = await deps.repo.listDueScheduled();
  let launched = 0;
  for (const c of due) {
    try {
      const credit = await deps.creditAuDepart.estimer(c.tenantId, c.id);
      if (credit !== null && credit.manqueMicroEur > 0) {
        await deps.creditAuDepart.pauser(c.id, c.tenantId, credit.montantMicroEur);
        continue;
      }
      await deps.enqueueRun(
        c.id,
        c.tenantId,
        campaignJobExpireSeconds(c.pendingCount, resolveRatePerMinute(c.ratePerMinute, deps.defaultRatePerMinute ?? 0, deps.plafondLePlusBas ?? SANS_PLAFOND)),
      );
      await deps.repo.markScheduledRunning(c.id);
      launched += 1;
    } catch (err) {
      deps.onError?.(`schedule-sweep: échec sur la campagne ${c.id}`, err);
    }
  }
  return launched;
}
