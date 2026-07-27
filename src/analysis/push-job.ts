import { buildEvent, type EnrichedAnalyzedEvent } from './connector-push';
import type { StoredConversationAnalysis } from './events';
import type { Enrichment } from './enrichment';

export interface PushJobDeps {
  /** Relit l'analyse COURANTE (fraîche) : le payload ne porte qu'une référence, jamais un snapshot figé. */
  getStoredAnalysis: (conversationId: string) => Promise<StoredConversationAnalysis | null>;
  getEnrichment: (conversationId: string) => Promise<Enrichment | null>;
  /**
   * État de synchro du numéro, en UN SEUL snapshot : `connected` (gate du push) + `pausedAt` (décision de rattrapage).
   * Lire les deux d'un coup ferme la course TOCTOU (un gate booléen + une re-lecture « en pause ? » pouvait rater la
   * marque si une reprise s'intercalait entre les deux).
   */
  getHubspotGateStatus: (tenantId: string, whatsappLine: string) => Promise<{ connected: boolean; pausedAt: string | null }>;
  post: (event: EnrichedAnalyzedEvent) => Promise<void>;
  /** Marque l'analyse à rattraper (inconditionnel : l'appelant décide, sur le snapshot ci-dessus). */
  markPendingCatchup: (conversationId: string) => Promise<void>;
  /** Efface la marque de rattrapage après un post réussi (best-effort côté handler). */
  clearPendingCatchup: (conversationId: string) => Promise<void>;
  /** Journalisation optionnelle (skip HubSpot). */
  log?: (msg: string) => void;
}

/**
 * Handler du job `push-analysis`. Contrat (F3-a) : le payload ne porte qu'une RÉFÉRENCE `{conversationId, tenantId}`,
 * et le handler refetch TOUJOURS l'état frais (analyse + enrichissement). C'est ce qui rend le rattrapage de pause SÛR :
 * rejouer un snapshot figé pourrait pousser un contenu périmé sous un eventId neuf (réanalyse entre-temps) -> ingéré
 * comme "nouveau" côté mm-hubspot alors qu'il est obsolète.
 *
 * GATE HubSpot par numéro (état LIVE, snapshot unique) : coupé/pausé -> skip. Si EN PAUSE au moment du skip, on MARQUE
 * l'analyse (`pending_catchup`) pour la rattraper à la reprise ; la décision se prend sur le MÊME snapshot que le gate
 * (pas de re-lecture racy). Une erreur de POST (429/5xx/réseau) REMONTE -> pg-boss rejoue (DLQ). L'eventId
 * (conversationId:analyzedAt) dédup côté connecteur -> un rattrapage ne double jamais une écriture.
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
    // EN PAUSE (pausedAt non-null dans CE snapshot) -> marque à rattraper. Jamais activé (pausedAt null) -> pas de
    // marque (on n'inonde pas HubSpot d'un historique jamais demandé). Décision sur le snapshot -> pas de re-lecture.
    // Le mark propage une éventuelle erreur -> pg-boss rejoue (ne pas perdre silencieusement une analyse à rattraper).
    if (gate.pausedAt !== null) await deps.markPendingCatchup(conversationId);
    deps.log?.(`push-analysis: ligne ${enr.whatsappLine} non connectée à HubSpot -> skip (conversation ${conversationId})`);
    return;
  }

  await deps.post(buildEvent(stored, enr));
  // Post réussi -> la reprise a bien poussé cette conversation : on efface la marque de rattrapage. Best-effort :
  // un échec ici laisse pending_catchup=true, qu'un futur rattrapage (reprise OU sweep) rejouera (POST dédupliqué
  // par eventId), pas de perte ni de double écriture ; ne jamais faire échouer un POST réussi pour du bookkeeping.
  try {
    await deps.clearPendingCatchup(conversationId);
  } catch (err) {
    deps.log?.(`push-analysis: clearPendingCatchup échoué (best-effort) pour ${conversationId}: ${err instanceof Error ? err.message : err}`);
  }
}
