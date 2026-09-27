/**
 * L'historique des essais d'un agent dans le bac à sable : régler un agent, c'est comparer la même question
 * avant et après un changement de consigne.
 *
 * Des essais, pas des conversations de clients : ni `wa_id` ni contact, seulement ce que l'administrateur a
 * tapé et ce que le modèle a répondu. C'est ce qui autorise une rétention courte, hors purge RGPD.
 */

/** Un tour d'essai, tel que l'écran le rejoue. */
export interface EssaiAgent {
  id: string;
  /** La conversation envoyée : sans elle, une réponse ne veut rien dire. */
  messages: Array<{ role: string; content: string }>;
  /** `null` est nominal : l'agent peut sortir sans rien dire. */
  reponse: string | null;
  sortie: string | null;
  /**
   * Les outils réellement appelés, dans l'ordre : c'est ce qui distingue « il n'a pas trouvé » de « il n'a
   * même pas cherché ».
   */
  appels: Array<{ nom: string; status: string }>;
  tokensEntree: number;
  tokensSortie: number;
  coutMicroEur: number;
  createdAt: string;
}

/** Ce qu'on écrit à la fin d'un essai. */
export interface EssaiAEcrire {
  messages: Array<{ role: string; content: string }>;
  reponse: string | null;
  sortie: string | null;
  appels: Array<{ nom: string; status: string }>;
  tokensEntree: number;
  tokensSortie: number;
  coutMicroEur: number;
}

export interface TestRunStore {
  /**
   * Enregistre un essai. Peut lever : c'est la route qui tient, pour ne pas perdre une réponse déjà facturée
   * à cause de l'historique.
   */
  ecrire(tenantId: string, agentId: string, essai: EssaiAEcrire): Promise<void>;
  /** Les derniers essais de cet agent, du plus récent au plus ancien. */
  lister(tenantId: string, agentId: string, limite: number): Promise<EssaiAgent[]>;
  /** Efface les essais plus vieux que `jours`. Rend le nombre de lignes parties. */
  purger(jours: number): Promise<number>;
}

/**
 * Combien d'essais l'écran montre. Un plafond, pas une pagination : on compare les derniers essais d'une
 * séance de réglage, la rétention fait le ménage.
 */
export const ESSAIS_AFFICHES = 20;

/**
 * Rétention, en jours : assez pour comparer dans la journée et revenir le lendemain, sans accumuler des mois
 * de brouillons.
 */
export const RETENTION_ESSAIS_JOURS = 14;
