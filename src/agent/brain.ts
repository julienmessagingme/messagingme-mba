/**
 * Le « cerveau » d'un tour d'agent : ce qui transforme un historique de conversation en une décision.
 *
 * Séparé derrière un contrat pour une raison précise : le chemin chaud (le tour, ses gardes, ses plafonds,
 * ses sorties) se teste et se durcit SANS réseau ni modèle, avec un cerveau bouchonné. Le vrai client
 * remplace le fake sans toucher au reste.
 */

export interface DecisionAgent {
  /**
   * Texte à envoyer au contact. `null` = ne rien envoyer : cas d'une sortie où c'est le bloc AVAL qui parle
   * (escalade vers un humain, branche de reprise du scénario). Un `null` n'est donc pas un échec.
   */
  texte: string | null;
  /**
   * Code de la sortie empruntée, sans son préfixe (`fini`, `escalade`...), ou `null` si l'agent a posé une
   * question et attend la réponse du contact. `null` laisse le parcours en attente sur le bloc.
   */
  sortie: string | null;
  /**
   * Consommation du tour. `coutMicroEur` est un `number` et non un `bigint`, pour la même raison qu'en base
   * (`session-store.ts`) : `JSON.stringify` LÈVE sur un BigInt, et ce chiffre finit dans une réponse d'API.
   */
  usage?: { tokensIn: number; tokensOut: number; coutMicroEur: number };
}

export interface AgentBrain {
  penser(input: {
    agentId: string;
    tenantId: string;
    /** L'historique de la conversation, tel que la session le porte. Opaque pour le tour. */
    transcript: unknown[];
    /** Échéance ABSOLUE (ms epoch) : le cerveau doit rendre la main avant, ou lever. */
    deadline: number;
  }): Promise<DecisionAgent>;
}
