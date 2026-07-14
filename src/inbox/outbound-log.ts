/** Ce dont a besoin le log sortant : juste `recordOutboundByWaId` (satisfait par PgInboxStore). */
export interface OutboundLogger {
  recordOutboundByWaId(
    tenantId: string,
    waId: string,
    msg: { body: string; messageId: string | null; type?: string; templateCategory?: string | null; templateName?: string | null },
  ): Promise<void>;
}

/**
 * Journalise (BEST-EFFORT) un template envoyé par un workflow dans le fil de conversation. Extrait de la closure
 * du worker pour être testable. Un échec de log ne propage JAMAIS (ne doit pas casser l'envoi Meta réussi).
 */
export async function logTemplateSent(
  inbox: OutboundLogger,
  tenantId: string,
  waId: string,
  templateName: string,
  messageId: string | null,
): Promise<void> {
  try {
    await inbox.recordOutboundByWaId(tenantId, waId, { body: `Template « ${templateName} »`, messageId, type: 'template', templateName });
  } catch {
    /* best-effort : ne casse pas l'envoi */
  }
}
