/**
 * Handler du job `hubspot-catchup` (F3-a) : à la RÉACTIVATION d'une synchro HubSpot mise en pause, re-enfile un
 * push-analysis (référence seule) pour chaque conversation marquée `pending_catchup`. Chaque push refetch l'état frais,
 * repasse le gate (désormais true), pousse, et efface la marque. Idempotent : un rejeu de ce job (ou un doublon)
 * re-enfile les mêmes refs -> POST dédupliqué par eventId côté mm-hubspot, jamais de double écriture. Fonction pure.
 */
export interface CatchupJobDeps {
  /** Conversations marquées à rattraper pour le tenant (registre durable, indépendant de paused_at). */
  listPendingCatchup: (tenantId: string) => Promise<string[]>;
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
  const ids = await deps.listPendingCatchup(tenantId);
  deps.log?.(`hubspot-catchup: ${ids.length} conversation(s) à rattraper pour ${tenantId}`);
  for (const conversationId of ids) await deps.enqueuePush({ conversationId, tenantId });
}
