/**
 * Job `hubspot-catchup` : à la réactivation d'une synchro HubSpot, re-enfile un push-analysis (référence seule) pour
 * chaque conversation marquée `pending_catchup`. Idempotent : un rejeu re-enfile les mêmes refs, dédupliquées par
 * eventId côté mm-hubspot.
 */
export interface CatchupJobDeps {
  /** Conversations marquées à rattraper pour le tenant (registre durable, indépendant de paused_at). */
  analyses: { listConversationIdsPendingCatchup(tenantId: string): Promise<string[]> };
  /** Re-enfile un push-analysis (référence seule). */
  enqueuePush: (ref: { conversationId: string; tenantId: string }) => Promise<void>;
  log?: (msg: string) => void;
}

export async function hubspotCatchupJob(data: unknown, deps: CatchupJobDeps): Promise<void> {
  const d = data as { tenantId?: unknown } | null;
  if (!d || typeof d.tenantId !== 'string' || d.tenantId === '') {
    throw new Error('hubspot-catchup : payload invalide (tenantId manquant)');
  }
  const tenantId = d.tenantId;
  const ids = await deps.analyses.listConversationIdsPendingCatchup(tenantId);
  deps.log?.(`hubspot-catchup: ${ids.length} conversation(s) à rattraper pour ${tenantId}`);
  for (const conversationId of ids) await deps.enqueuePush({ conversationId, tenantId });
}
