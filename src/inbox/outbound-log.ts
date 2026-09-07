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
 * Ce qu'on sait de l'envoi EN PLUS de son nom, et qui décide s'il sera chiffrable.
 *
 * 🔴 UN OBJET, PAS UN PARAMÈTRE POSITIONNEL DE PLUS. Cette fonction en avait déjà cinq. Le CLAUDE.md du
 * dépôt le dit : une flèche à deux paramètres reste assignable à un contrat qui en déclare trois, et le
 * troisième est avalé EN SILENCE. Un champ oublié dans un objet est visible du compilateur, un argument
 * oublié en position ne l'est pas.
 */
export interface ContexteTemplateSortant {
  /**
   * La catégorie Meta du template, EN MINUSCULES ('marketing' | 'utility'), comme la base la stocke déjà
   * côté campagne.
   *
   * 🔴 SANS ELLE, L'ENVOI N'EST PAS CHIFFRABLE. `estimateCostSeries` (`src/stats/cost.ts`) ignore toute
   * ligne sans catégorie : le volume remonte, le coût reste à zéro, et l'écran n'en dit rien. Vécu le
   * 2026-09-07, où 22 envois de scénario du tenant Demo étaient invisibles du coût estimé.
   *
   * Reste FACULTATIVE : une lecture de template en échec ne doit jamais empêcher un envoi réussi d'être
   * journalisé, et une catégorie INVENTÉE serait pire qu'absente (elle se facturerait au mauvais tarif).
   */
  templateCategory?: string | null;
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
