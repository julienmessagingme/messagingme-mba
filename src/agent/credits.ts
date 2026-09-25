/**
 * Le solde prépayé d'un workspace pour l'agent IA.
 *
 * 🔴 C'EST CE QUI REND LE BUDGET VRAI. Avant ce module, la console affichait un budget que rien ne
 * décrémentait : le coût d'un tour n'était écrit nulle part, donc le plafond était un réglage décoratif.
 * Ici le coût RÉEL rendu par le fournisseur descend le solde à chaque tour, et un solde épuisé arrête les
 * agents du workspace au lieu de laisser la dépense creuser.
 *
 * ⚠️ LA GARDE EST À L'ENTRÉE DU TOUR, PAS À L'ÉCRITURE. Le solde peut finir légèrement négatif, et c'est
 * voulu : un tour déjà joué a déjà coûté chez le fournisseur, et refuser de l'enregistrer pour garder un zéro
 * propre reviendrait à offrir la dernière conversation. On refuse de DÉMARRER quand il n'y a plus rien, on
 * n'efface pas ce qui a été dépensé.
 */

/** Ce qui a fait bouger un solde. La liste vit ici et pas en base : une valeur de plus ne doit pas demander
 *  une migration. */
export type RaisonMouvement = 'conso' | 'recharge';

export interface MouvementCredit {
  /** Négatif = consommation, positif = rechargement. */
  deltaMicroEur: number;
  raison: RaisonMouvement;
  /** La session qui a consommé, quand il y en a une. Absente pour un essai depuis la console (qui consomme
   *  vraiment, mais n'ouvre aucune session) et pour un rechargement. */
  sessionId?: string;
  /** Pourquoi ce mouvement. TOUJOURS renseignée sur un rechargement, c'est ce qui le rend explicable. */
  note?: string;
}

export interface MouvementLu extends MouvementCredit {
  id: string;
  at: string;
}

