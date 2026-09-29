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
 *   - `offert` : le crédit offert à la connexion du premier numéro WhatsApp de l'espace (une fois par espace, jamais
 *     deux fois pour le même numéro, migration 0191) ;
 *   - `achat` : un paiement Stripe, crédité par le webhook (`src/stripe/`), une fois par session Checkout.
 */
export type RaisonMouvement = 'conso' | 'recharge' | 'traduction' | 'offert' | 'achat';

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
 * écrite par une version plus récente ne doit ni casser la lecture ni se déguiser en consommation. Les valeurs
 * connues sont celles de `RaisonMouvement`.
 */
export interface MouvementLu extends Omit<MouvementCredit, 'raison'> {
  id: string;
  at: string;
  raison: string;
}

/**
 * Une ligne de l'historique que la console montre au client (page Crédit IA).
 *
 * 🔴 SANS NOTE, délibérément : celle d'une recharge manuelle porte l'adresse de l'exploitant et sa raison interne
 * (`noteSignee`, `src/http/ops.ts`), qui n'ont rien à faire chez le client. L'écran dit la raison en clair.
 * `jour` (AAAA-MM-JJ, Paris) est posé sur les lignes qui agrègent une journée : les traductions (une ligne par jour
 * en base, migration 0190) et les tours d'agent (agrégés à la lecture, sinon ils noient tout le reste).
 */
export interface LigneHistorique {
  id: string;
  deltaMicroEur: number;
  raison: string;
  jour: string | null;
  at: string;
}

