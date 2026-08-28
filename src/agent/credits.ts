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

export interface CreditStore {
  /**
   * Le solde d'un workspace, en micro-euros. `0` si aucune ligne n'existe encore.
   *
   * ⚠️ Zéro par défaut veut dire « rien à dépenser », donc les agents ne démarrent pas tant que personne n'a
   * rechargé. C'est le bon défaut : l'inverse (un crédit implicite) ferait payer une consommation que
   * personne n'a autorisée, sur un compte qui n'existe pas.
   */
  solde(tenantId: string): Promise<number>;

  /**
   * Retire du solde et laisse une trace, EN UNE SEULE INSTRUCTION. Rend le solde après opération.
   *
   * Atomique parce que deux tours du même workspace peuvent se jouer en parallèle sur le worker : un
   * `lire puis écrire` perdrait une des deux consommations, et le client paierait moins que ce qu'il a
   * consommé (ou l'inverse le jour où le sens s'inverse).
   */
  debiter(tenantId: string, montantMicroEur: number, contexte?: { sessionId?: string; note?: string }): Promise<number>;

  /**
   * Ajoute au solde et laisse une trace. Rend le solde après opération.
   *
   * `note` est OBLIGATOIRE, et c'est la seule trace de qui recharge et pourquoi : le jeton d'exploitation est
   * partagé, il n'y a aucune identité d'opérateur à enregistrer à la place. Un mouvement d'argent sans
   * explication est exactement ce qu'on ne saura pas justifier six mois plus tard.
   */
  crediter(tenantId: string, montantMicroEur: number, note: string): Promise<number>;

  /** Le journal, du plus récent au plus ancien. C'est ce qui rend une baisse de solde explicable. */
  mouvements(tenantId: string, limite: number): Promise<MouvementLu[]>;
}
