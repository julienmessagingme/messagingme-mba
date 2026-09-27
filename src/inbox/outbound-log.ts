import type { OrigineMessage } from './origine';

/** Ce dont a besoin le log sortant : juste `recordOutboundByWaId` (satisfait par PgInboxStore). */
export interface OutboundLogger {
  recordOutboundByWaId(
    tenantId: string,
    waId: string,
    msg: { body: string; messageId: string | null; type?: string; templateCategory?: string | null; templateName?: string | null; origine: OrigineMessage },
  ): Promise<void>;
}

/**
 * Ce qu'on sait de l'envoi en plus de son nom, et qui décide s'il sera chiffrable. Un objet plutôt qu'un
 * paramètre positionnel de plus : un champ oublié se voit du compilateur, un argument oublié en position non.
 */
export interface ContexteTemplateSortant {
  /**
   * La catégorie Meta du template, en minuscules ('marketing' | 'utility'). 🔴 Sans elle, l'envoi n'est pas
   * chiffrable : `estimateCostSeries` ignore toute ligne sans catégorie, et le coût reste à zéro sans le dire.
   * Facultative : une lecture de template en échec ne doit pas empêcher de journaliser, et une catégorie
   * inventée se facturerait au mauvais tarif.
   */
  templateCategory?: string | null;
}

/**
 * Journalise (best-effort) un template envoyé par un scénario dans le fil de conversation. Un échec de journal
 * ne se propage jamais : il ne doit pas casser l'envoi Meta réussi.
 */
export async function logTemplateSent(
  inbox: OutboundLogger,
  tenantId: string,
  waId: string,
  templateName: string,
  messageId: string | null,
  ctx: ContexteTemplateSortant = {},
): Promise<void> {
  try {
    // Un template envoyé par un scénario : l'origine est le scénario, pas la campagne (une campagne
    // passe par `campaign/engine.ts`, qui pose la sienne).
    await inbox.recordOutboundByWaId(tenantId, waId, {
      body: `Template « ${templateName} »`, messageId, type: 'template', templateName, origine: 'scenario',
      ...(ctx.templateCategory ? { templateCategory: ctx.templateCategory } : {}),
    });
  } catch {
    /* best-effort : ne casse pas l'envoi */
  }
}
