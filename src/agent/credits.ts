/**
 * Le solde prépayé d'un workspace pour l'agent IA : le coût réel rendu par le fournisseur le décrémente à
 * chaque tour, et un solde épuisé arrête les agents du workspace.
 *
 * 🔴 La garde est à l'entrée du tour, pas à l'écriture : le solde peut finir légèrement négatif. Un tour joué a
 * déjà coûté chez le fournisseur, refuser de l'enregistrer offrirait la dernière conversation.
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
  /** Pourquoi ce mouvement. Toujours renseignée sur un rechargement, c'est ce qui le rend explicable. */
  note?: string;
}

export interface MouvementLu extends MouvementCredit {
  id: string;
  at: string;
}

