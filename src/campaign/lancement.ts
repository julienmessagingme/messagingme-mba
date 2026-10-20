import type { Queue } from '../queue/queue';
import { campaignJobExpireSeconds, resolveRatePerMinute } from './pacing';

/**
 * LE LANCEMENT D'UNE CAMPAGNE, partagé par le bouton « Lancer » de la console (`POST /campaigns/:campaignId/run`) et par
 * l'outil `launch_campaign` de l'assistant. 🔴 Une seule copie : une seconde dériverait, et sur le chemin d'envoi de
 * masse ce serait un assistant qui lance avec d'autres garde-fous (ordre pause puis enfilement, groupe de l'espace,
 * modèles du mois).
 */
export interface DepsLancement {
  repo: {
    /** La campagne appartient-elle à l'espace ? Sinon « inconnue » : pas d'IDOR entre espaces. */
    campaignBelongsTo(campaignId: string, tenantId: string): Promise<boolean>;
    /** Programme (draft ou paused) pour un lancement futur. false = déjà en cours ou terminée. */
    scheduleCampaign(campaignId: string, tenantId: string, scheduledAt: Date): Promise<boolean>;
    /** Lève la pause (`paused` uniquement, no-op ailleurs). */
    resumeCampaign(campaignId: string, tenantId: string): Promise<boolean>;
    /** Suspend (`running` uniquement) : rétablit la pause quand l'enfilement échoue. */
    pauseCampaign(campaignId: string, tenantId: string): Promise<boolean>;
    getRunSizing(campaignId: string): Promise<{ ratePerMinute: number | null; pendingCount: number } | null>;
  };
  queue: Pick<Queue, 'enqueue'>;
  /** Les modèles du mois : la limite, ce qu'il en reste, ce que la campagne enverrait. `null` = sans limite. */
  modelesDuLancement(tenantId: string, campaignId: string): Promise<{ max: number; reste: number; demandes: number } | null>;
  defaultRatePerMinute: number;
  plafondLePlusBas: number;
}

export type IssueLancement =
  | { ok: true; programmee: Date }
  | { ok: true; enfilee: true }
  | { ok: false; raison: 'inconnue' | 'date_passee' | 'non_programmable' }
  | { ok: false; raison: 'limite'; max: number; reste: number; demandes: number };

/**
 * L'expiration du job d'un run, dimensionnée sur le travail réel (destinataires en attente / débit résolu) : un run
 * throttlé long ne doit pas expirer et être rejoué en parallèle. `undefined` (campagne introuvable) = le défaut de la file.
 */
export async function expirationDuRun(deps: DepsLancement, campaignId: string): Promise<number | undefined> {
  const sizing = await deps.repo.getRunSizing(campaignId);
  return sizing
    ? campaignJobExpireSeconds(sizing.pendingCount, resolveRatePerMinute(sizing.ratePerMinute, deps.defaultRatePerMinute, deps.plafondLePlusBas))
    : undefined;
}

/**
 * Lance tout de suite (`quand` null) ou programme (`quand` daté). Une date passée est refusée, jamais changée en
 * lancement immédiat déguisé.
 */
export async function lancerCampagne(deps: DepsLancement, tenantId: string, campaignId: string, quand: Date | null): Promise<IssueLancement> {
  if (!(await deps.repo.campaignBelongsTo(campaignId, tenantId))) return { ok: false, raison: 'inconnue' };

  // « Plus tard » : le sweeper enfilera le run à l'échéance. Statut 'scheduled', annulable via /cancel-schedule.
  if (quand !== null) {
    if (quand.getTime() <= Date.now()) return { ok: false, raison: 'date_passee' };
    if (!(await deps.repo.scheduleCampaign(campaignId, tenantId, quand))) return { ok: false, raison: 'non_programmable' };
    return { ok: true, programmee: quand };
  }

  // Les modèles du mois (lot 6) : une campagne qui ne tient pas dans ce qu'il reste est refusée d'emblée, avant toute
  // levée de pause, plutôt que de s'arrêter au milieu. Seul le lancement immédiat : une campagne programmée part un
  // autre jour, peut-être un autre mois, et la fabrique décide alors.
  const modeles = await deps.modelesDuLancement(tenantId, campaignId);
  if (modeles !== null && modeles.demandes > modeles.reste) {
    return { ok: false, raison: 'limite', max: modeles.max, reste: modeles.reste, demandes: modeles.demandes };
  }

  const expireInSeconds = await expirationDuRun(deps, campaignId);
  // Reprise d'une campagne en pause : la pause est levée avant l'enfilement, parce que le job refuse de démarrer une
  // campagne en pause (garde de `campaignRunJob`, qui empêche un job enfilé avant la pause de la ressusciter). No-op sur
  // un brouillon, donc l'appel est inconditionnel.
  await deps.repo.resumeCampaign(campaignId, tenantId);
  // Deux lancements concurrents empilent deux jobs, et les deux tournent : rien ne déduplique la file. 🔴 Le claim
  // atomique par destinataire est le seul garde-fou contre le double envoi (pas contre le débit).
  try {
    // `groupId` = l'espace : le plafond de concurrence par espace de la file s'applique aussi au lancement manuel,
    // sinon un client qui clique quatre fois occupe les quatre places.
    await deps.queue.enqueue('campaign-run', { campaignId }, { ...(expireInSeconds ? { expireInSeconds } : {}), groupId: tenantId });
  } catch (err) {
    // L'enfilement a échoué après la levée de pause : on la rétablit, sinon la campagne resterait « en cours » sans
    // job, et « Reprendre » ne s'afficherait pas. `pauseCampaign` est bornée à `running` (pas un brouillon).
    await deps.repo.pauseCampaign(campaignId, tenantId);
    throw err;
  }
  return { ok: true, enfilee: true };
}
