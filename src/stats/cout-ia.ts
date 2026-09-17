/**
 * CE QUE LE CLIENT A DEPENSE EN IA, sur SON crédit prépayé.
 *
 * 🔴 SON CREDIT, ET RIEN D'AUTRE (décidé avec Julien le 2026-09-17). Ce que MessagingMe absorbe sur sa
 * propre clé (la transcription des vocaux, le bot d'aide de la console, les deux assistants de
 * configuration) n'a rien à faire sur l'écran d'un client : il se demanderait pourquoi on lui montre une
 * dépense qu'on ne lui facture pas, et la question suivante porterait sur notre coût interne.
 *
 * 🔴 ET LE META BUSINESS AGENT N'EST PAS UNE MESURE MANQUANTE. Il tourne CHEZ Meta
 * (`src/mba/client.ts`, `api.facebook.com`) : nous le configurons, nous ne payons aucun token pour lui, et
 * Meta le facture au MESSAGE DE SERVICE. Son coût est donc déjà dans la ligne « messages » de la carte.
 * L'écran doit le dire, sinon un lecteur conclura qu'on a oublié de le compter.
 *
 * ⚠️ TOUT EST EN MICRO-EUROS, comme en base (`agent_sessions.cout_micro_eur`). Aucun arrondi ici : un coût
 * d'IA se compte au millionième d'euro et un arrondi côté serveur ferait diverger le total de la somme de
 * ses lignes. La conversion en euros est un geste d'AFFICHAGE, et elle vit dans la console.
 */

/** Un tour d'agent, tel que l'accordéon de la carte le montre. */
export interface TourIa {
  id: string;
  agentId: string;
  /** Nombre d'allers-retours avec le modèle dans cette session. */
  tours: number;
  tokensEntree: number;
  tokensSortie: number;
  coutMicroEur: number;
  /** Instant ISO du début de la session. */
  at: string;
}

export interface CoutIa {
  coutMicroEur: number;
  tokensEntree: number;
  tokensSortie: number;
  /** Nombre de sessions d'agent sur la période. ⚠️ Zéro est un état NORMAL, pas une panne. */
  sessions: number;
  tours: TourIa[];
  /** La liste est plafonnée et le DIT : une troncature muette se lit comme un inventaire complet. */
  tronque: boolean;
}

/**
 * Combien de tours l'accordéon montre au plus.
 *
 * ⚠️ Une liste sans borne est un défaut, pas un confort : la plage accepte jusqu'à 366 jours, et un espace
 * actif y porterait des milliers de tours, dans un accordéon qu'on ouvre pour se faire une idée. Même règle
 * que `PLAFOND_CAMPAGNES_SYNTHESE`, et le SQL en demande un de plus pour savoir qu'il tronque.
 */
export const PLAFOND_TOURS_IA = 50;
