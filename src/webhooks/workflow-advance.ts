import { extractInbound } from './inbound';

/** Fait avancer le run de workflow en attente d'un contact quand il envoie un message entrant. */
export interface WorkflowAdvanceDeps {
  /** Tenant propriétaire du numéro business (mappe le message à un tenant). null si inconnu. */
  phoneNumberTenant(phoneNumberId: string): Promise<string | null>;
  /** Avance le run en attente de ce contact (no-op si aucun / message déjà traité). */
  advance(tenantId: string, waId: string, messageId: string): Promise<void>;
}

/**
 * Avance les workflows sur les messages entrants (une réponse du contact = un pas dans le graphe). ISOLÉ
 * dans le handler (ne doit JAMAIS faire échouer le job webhook partagé avec les statuts/inbox/flow). V1 :
 * n'importe quelle réponse fait avancer le run en attente (pas de branche par bouton).
 */
export async function processWorkflowAdvance(payload: unknown, deps: WorkflowAdvanceDeps): Promise<void> {
  for (const m of extractInbound(payload)) {
    // Isolation PAR MESSAGE : une erreur sur un contact ne doit pas empêcher l'avance des autres contacts
    // du même webhook (Meta peut batcher plusieurs messages). Calqué sur processFlowCompletions.
    try {
      const tenantId = await deps.phoneNumberTenant(m.phoneNumberId);
      if (tenantId) await deps.advance(tenantId, m.waId, m.messageId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('processWorkflowAdvance: message ignoré:', err instanceof Error ? err.message : err);
    }
  }
}
