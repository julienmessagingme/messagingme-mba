import type { ConversationAnalysis } from './schema';
import type { CopieFiche } from './fiche';

/** Analyse stockée + son identité de conversation (payload du point de sortie). */
export interface StoredConversationAnalysis extends ConversationAnalysis {
  conversationId: string;
  tenantId: string;
}

/**
 * Ce que le point de sortie reçoit : l'analyse stockée, plus ce qu'elle a recopié sur la fiche du contact (lot 3
 * de « Tout sur la fiche »). Un type À PART : `StoredConversationAnalysis` est aussi le contrat de la poussée
 * HubSpot, qui n'a rien à faire de la copie.
 */
export interface AnalyseTerminee extends StoredConversationAnalysis {
  /** Ancienne et nouvelle copie sur la fiche, ou `null` : aucune fiche active, ou une analyse plus récente déjà en place. */
  copieFiche: CopieFiche | null;
}

/** Point de sortie « cette conversation a été analysée », sans couplage à un consommateur (no-op par défaut). */
export type OnConversationAnalyzed = (analysis: AnalyseTerminee) => Promise<void>;

/** Le no-op accepte l'analyse stockée, donc aussi une `AnalyseTerminee` : il convient à la poussée comme au point de sortie. */
export const noopOnAnalyzed: (analysis: StoredConversationAnalysis) => Promise<void> = async () => {};
