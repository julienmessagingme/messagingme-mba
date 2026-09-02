import { extractInbound } from './inbound';

/** Fait avancer le run de workflow en attente d'un contact quand il envoie un message entrant. */
export interface WorkflowAdvanceDeps {
  /** Tenant propriétaire du numéro business (mappe le message à un tenant). null si inconnu. */
  phoneNumberTenant(phoneNumberId: string): Promise<string | null>;
  /** Avance le run en attente de ce contact. `buttonPayload` = bouton tapé (branche par bouton). */
  advance(tenantId: string, waId: string, messageId: string, buttonPayload: string | null): Promise<void>;
  /**
   * Consigne un échec d'avance là où quelqu'un le verra (migration 0108, lot 4 du plan post-audit).
   *
   * 🔴 L'isolation par message est BONNE et ne bouge pas : une erreur sur un contact ne doit pas emporter les
   * autres messages du même webhook. C'était l'acquittement SILENCIEUX qui ne allait pas : le job se terminait
   * en succès, donc aucun rejeu, aucune DLQ, aucune trace consultable, et le contact restait bloqué sur son
   * bloc sans que personne l'apprenne.
   *
   * OPTIONNELLE et best-effort : absente ou en échec -> on retombe sur le message de log, comme avant.
   */
  journaliserEchec?(e: { tenantId: string; waId: string; messageId: string; erreur: string }): Promise<void>;
}

/**
 * Avance les workflows sur les messages entrants (une réponse du contact = un pas dans le graphe). ISOLÉ
 * dans le handler (ne doit JAMAIS faire échouer le job webhook partagé avec les statuts/inbox/flow). Le
 * bouton tapé (`m.buttonPayload`) sélectionne la branche ; une réponse texte suit la 1re arête sortante.
 */
export async function processWorkflowAdvance(payload: unknown, deps: WorkflowAdvanceDeps, consumed?: ReadonlySet<string>): Promise<void> {
  for (const m of extractInbound(payload)) {
    // Message déjà consommé par une étape prioritaire (jeton de test) : ce n'est pas une réponse du contact
    // à son parcours, le traiter comme telle ferait avancer le scénario d'un cran pour rien.
    if (consumed?.has(m.messageId)) continue;
    // Ne PAS faire avancer le scénario sur un `standby` (le MBA tient le fil) : répondre reprendrait implicitement
    // le contrôle au MBA. L'inbox, elle, enregistre bien ce message (processInbound, non filtré) pour rester visible.
    // field null (anciennes fixtures) -> on avance (rétro-compat).
    if (m.field && m.field !== 'messages') continue;
    // Isolation PAR MESSAGE : une erreur sur un contact ne doit pas empêcher l'avance des autres contacts
    // du même webhook (Meta peut batcher plusieurs messages). Calqué sur processFlowCompletions.
    // Résolu HORS du try : sans tenant, un échec ne peut être rangé nulle part, et c'est justement ce
    // qu'on veut savoir en le journalisant.
    let tenantId: string | null = null;
    try {
      tenantId = await deps.phoneNumberTenant(m.phoneNumberId);
      if (tenantId) await deps.advance(tenantId, m.waId, m.messageId, m.buttonPayload);
    } catch (err) {
      const erreur = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('processWorkflowAdvance: message ignoré:', erreur);
      // Best-effort, et à la fin : un journal d'échec qui ferait échouer le traitement qu'il observe serait
      // une très mauvaise idée. Sans tenant, le log reste le seul canal possible.
      if (tenantId && deps.journaliserEchec) {
        await deps.journaliserEchec({ tenantId, waId: m.waId, messageId: m.messageId, erreur }).catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.error('processWorkflowAdvance: échec NON journalisé:', e instanceof Error ? e.message : e);
        });
      }
    }
  }
}
