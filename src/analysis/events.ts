import type { ConversationAnalysis } from './schema';

/** Analyse stockée + son identité de conversation (payload du point de sortie). */
export interface StoredConversationAnalysis extends ConversationAnalysis {
  conversationId: string;
  tenantId: string;
}

/**
 * Point de sortie : « cette conversation a été analysée ». Interface d'extension que les pièces 2 (connecteur HubSpot)
 * et 3 (onglet tendances) consommeront plus tard. V1 = no-op : aucun consommateur codé ici (ce lot ne couvre que
 * l'analyse). Ne PAS coupler ce lot à HubSpot.
 */
export type OnConversationAnalyzed = (analysis: StoredConversationAnalysis) => Promise<void>;

export const noopOnAnalyzed: OnConversationAnalyzed = async () => {};
