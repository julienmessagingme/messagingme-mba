import type { ConversationAnalysis } from './schema';

/** Analyse stockée + son identité de conversation (payload du point de sortie). */
export interface StoredConversationAnalysis extends ConversationAnalysis {
  conversationId: string;
  tenantId: string;
}

/** Point de sortie « cette conversation a été analysée », sans couplage à un consommateur (no-op par défaut). */
export type OnConversationAnalyzed = (analysis: StoredConversationAnalysis) => Promise<void>;

export const noopOnAnalyzed: OnConversationAnalyzed = async () => {};
