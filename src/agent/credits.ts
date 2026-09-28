/**
 * Le solde prépayé d'un workspace pour l'agent IA : le coût réel rendu par le fournisseur le décrémente à
 * chaque tour, et un solde épuisé arrête les agents du workspace.
 *
 * 🔴 La garde est à l'entrée du tour, pas à l'écriture : le solde peut finir légèrement négatif. Un tour joué a
 * déjà coûté chez le fournisseur, refuser de l'enregistrer offrirait la dernière conversation.
 */

/**
 * Ce qui a fait bouger un solde. La liste vit ici et pas en base : une valeur de plus ne doit pas demander
 * une migration.
 *   - `conso` : un tour d'agent ou un essai depuis la console ;
 *   - `recharge` : un rechargement manuel (`/ops`) ;
 *   - `traduction` : les traductions d'un JOUR (Paris), agrégées en une ligne qui grossit ;
 *   - `offert` : le crédit offert à la création de l'espace.
 */
export type RaisonMouvement = 'conso' | 'recharge' | 'traduction' | 'offert';

export interface MouvementCredit {
  /** Négatif = consommation, positif = rechargement. */
  deltaMicroEur: number;
  raison: RaisonMouvement;
  /** La session qui a consommé, quand il y en a une. Absente pour un essai depuis la console (qui consomme
   *  vraiment, mais n'ouvre aucune session), pour une traduction et pour un crédit ajouté. */
  sessionId?: string;
  /** Pourquoi ce mouvement. Toujours renseignée sur un rechargement, c'est ce qui le rend explicable. */
  note?: string;
}

/**
 * Un mouvement relu. `raison` est rendue TELLE QU'ÉCRITE, et c'est pour ça qu'elle est une chaîne : une valeur
 * écrite par une version plus récente (un achat, demain) ne doit ni casser la lecture ni se déguiser en
 * consommation. Les valeurs connues sont celles de `RaisonMouvement`.
 */
export interface MouvementLu extends Omit<MouvementCredit, 'raison'> {
  id: string;
  at: string;
  raison: string;
}

