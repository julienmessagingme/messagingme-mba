/**
 * Ce que le client a dépensé en IA, sur son crédit prépayé et rien d'autre : ce que MessagingMe absorbe sur sa
 * propre clé (transcription, bot d'aide, assistants de configuration) n'a rien à faire sur son écran.
 *
 * Le Meta Business Agent n'est pas une mesure manquante : il tourne chez Meta, qui le facture au message de
 * service, donc son coût est déjà dans la ligne « messages ». L'écran doit le dire.
 *
 * 🔴 Tout est en micro-euros, comme en base (`agent_sessions.cout_micro_eur`), sans arrondi : un arrondi côté
 * serveur ferait diverger le total de la somme de ses lignes. La conversion en euros est un geste d'affichage.
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
  /** Nombre de sessions d'agent sur la période. Zéro est un état normal, pas une panne. */
  sessions: number;
  tours: TourIa[];
  /** La liste est plafonnée et le dit : une troncature muette se lit comme un inventaire complet. */
  tronque: boolean;
}

/**
 * Combien de tours l'accordéon montre au plus : la plage va jusqu'à 366 jours, un espace actif y porterait des
 * milliers de tours. Le SQL en demande un de plus pour savoir qu'il tronque.
 */
export const PLAFOND_TOURS_IA = 50;
