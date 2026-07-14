import type { ConversationAnalysis } from './schema';

/**
 * Déclencheur REMPLAÇABLE : « cette conversation est prête à analyser ». V1 = balayage d'inactivité qui enqueue un job.
 * Le jour où on veut le temps réel (signal d'un flow), on branche une autre implémentation SANS toucher au reste.
 */
export type OnConversationReady = (conversationId: string, tenantId: string) => Promise<void>;

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
