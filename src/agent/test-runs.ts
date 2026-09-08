/**
 * L'HISTORIQUE DES ESSAIS d'un agent, dans le bac à sable.
 *
 * 🔴 POURQUOI IL EXISTE. Julien, le 2026-09-08 : « j'ai voulu réappuyer et j'ai plus la trace de ce que j'ai
 * lu ». Régler un agent, c'est COMPARER : on change une consigne, on repose la même question, et on regarde
 * si la réponse a bougé. Sans trace, la comparaison se fait de mémoire, donc mal, et on ne sait jamais si le
 * réglage a servi.
 *
 * ⚠️ CE SONT DES ESSAIS, PAS DES CONVERSATIONS DE CLIENTS. Le bac à sable ne parle à personne : ces lignes ne
 * portent ni `wa_id` ni contact, seulement ce que l'administrateur a tapé et ce que le modèle a répondu.
 * C'est ce qui autorise une rétention courte et simple, sans le soin particulier que demande la purge RGPD
 * des conversations réelles.
 */

/** Un tour d'essai, tel que l'écran le rejoue. */
export interface EssaiAgent {
  id: string;
  /** La conversation ENVOYÉE : sans elle, une réponse ne veut rien dire. */
  messages: Array<{ role: string; content: string }>;
  /** `null` est NOMINAL : l'agent peut sortir sans rien dire. */
  reponse: string | null;
  sortie: string | null;
  /**
   * Les outils réellement appelés, dans l'ordre.
   *
   * 🔴 C'est ce qui distingue « il n'a pas trouvé » de « il n'a même pas cherché », et c'est la question
   * qu'on se pose en premier devant une mauvaise réponse. Un agent qui répond à côté sans avoir appelé sa
   * base de connaissance n'a pas le même défaut que celui qui l'a interrogée pour rien.
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
   * Enregistre un essai.
   *
   * ⚠️ IL PEUT LEVER, et c'est l'APPELANT qui doit tenir : un historique qui casserait l'essai lui-même
   * échangerait une commodité contre la fonctionnalité qu'elle sert (le client perdrait la réponse qu'on
   * vient de lui facturer pour qu'on puisse la lui montrer plus tard). La garde est posée UNE fois, dans la
   * route, plutôt que redemandée à chaque implémentation par un commentaire que rien ne vérifie.
   */
  ecrire(tenantId: string, agentId: string, essai: EssaiAEcrire): Promise<void>;
  /** Les derniers essais de cet agent, du plus récent au plus ancien. */
  lister(tenantId: string, agentId: string, limite: number): Promise<EssaiAgent[]>;
  /** Efface les essais plus vieux que `jours`. Rend le nombre de lignes parties. */
  purger(jours: number): Promise<number>;
}

/**
 * Combien d'essais l'écran montre.
 *
 * ⚠️ Un plafond, pas une pagination : on vient comparer les DERNIERS essais, pas fouiller un journal. Vingt
 * couvre une séance de réglage ; au-delà, la rétention de 14 jours fait le ménage.
 */
export const ESSAIS_AFFICHES = 20;

/**
 * Rétention, en jours. Choisie par Julien le 2026-09-08.
 *
 * Assez pour comparer deux essais dans la journée et revenir le lendemain, assez court pour ne pas accumuler
 * des mois de brouillons.
 */
export const RETENTION_ESSAIS_JOURS = 14;
