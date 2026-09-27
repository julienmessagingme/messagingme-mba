import { buildEvent, type EnrichedAnalyzedEvent } from './connector-push';
import type { StoredConversationAnalysis } from './events';
import type { Enrichment } from './enrichment';
import { messageDe } from '../lib/erreur';

export interface PushJobDeps {
  /** Relit l'analyse courante : le payload ne porte qu'une référence, jamais un instantané figé. */
  getStoredAnalysis: (conversationId: string) => Promise<StoredConversationAnalysis | null>;
  getEnrichment: (conversationId: string) => Promise<Enrichment | null>;
  /**
   * État de synchro du numéro en un seul instantané : `connected` (le gate) et `pausedAt` (le rattrapage). Les lire
   * ensemble ferme la course où une reprise s'intercalerait entre deux lectures.
   */
  getHubspotGateStatus: (tenantId: string, whatsappLine: string) => Promise<{ connected: boolean; pausedAt: string | null }>;
  post: (event: EnrichedAnalyzedEvent) => Promise<void>;
  /** Marque l'analyse à rattraper (inconditionnel : l'appelant décide, sur l'instantané ci-dessus). */
  markPendingCatchup: (conversationId: string) => Promise<void>;
  /** Efface la marque de rattrapage après un post réussi (best-effort). */
  clearPendingCatchup: (conversationId: string) => Promise<void>;
  /** Journalisation optionnelle (skip HubSpot). */
  log?: (msg: string) => void;
}

/**
 * Job `push-analysis`. Le payload ne porte qu'une référence et le handler relit toujours l'état frais : rejouer un
 * instantané figé pourrait pousser un contenu périmé sous un eventId neuf, ingéré comme nouveau par mm-hubspot.
 *
 * Gate HubSpot par numéro : coupé ou en pause, on saute. En pause, on marque l'analyse (`pending_catchup`) pour la
 * rattraper à la reprise, décision prise sur le même instantané que le gate. Une erreur de POST remonte (pg-boss
 * rejoue) ; l'eventId (conversationId:analyzedAt) dédoublonne côté connecteur.
 */
export async function pushAnalysisJob(data: unknown, deps: PushJobDeps): Promise<void> {
  const d = data as { conversationId?: unknown; tenantId?: unknown } | null;
  if (!d || typeof d.conversationId !== 'string' || d.conversationId === '' || typeof d.tenantId !== 'string' || d.tenantId === '') {
    throw new Error('push-analysis : payload invalide (conversationId/tenantId manquant)');
  }
  const conversationId = d.conversationId;
  const tenantId = d.tenantId;
  const [stored, enr] = await Promise.all([deps.getStoredAnalysis(conversationId), deps.getEnrichment(conversationId)]);
  if (!stored || !enr) return; // analyse ou conversation disparue -> rien à pousser

  const gate = await deps.getHubspotGateStatus(tenantId, enr.whatsappLine);
  if (!gate.connected) {
    // Jamais activé (pausedAt null) : pas de marque, on n'inonde pas HubSpot d'un historique jamais demandé.
    // L'erreur de marquage remonte : pg-boss rejoue plutôt que de perdre une analyse à rattraper.
    if (gate.pausedAt !== null) await deps.markPendingCatchup(conversationId);
    deps.log?.(`push-analysis: ligne ${enr.whatsappLine} non connectée à HubSpot -> skip (conversation ${conversationId})`);
    return;
  }

  await deps.post(buildEvent(stored, enr));
  // Best-effort : un échec laisse `pending_catchup`, qu'un rattrapage futur rejouera (POST dédoublonné) ; un POST
  // réussi n'échoue jamais pour de la comptabilité.
  try {
    await deps.clearPendingCatchup(conversationId);
  } catch (err) {
    deps.log?.(`push-analysis: clearPendingCatchup échoué (best-effort) pour ${conversationId}: ${messageDe(err)}`);
  }
}
