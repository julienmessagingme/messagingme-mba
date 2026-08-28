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

/**
 * Où en est CE tour, pour un cerveau qui appelle des outils.
 *
 * 🔴 IL EST PASSÉ À L'APPEL, ET NON FIGÉ À LA CONSTRUCTION. Un worker sert toutes les conversations de tous
 * les clients avec UN cerveau : un contexte figé au câblage ferait exécuter les outils du contact A dans la
 * conversation de B. Les compteurs viennent de la SESSION, relue à chaque tour : ce sont eux qui rendent les
 * plafonds d'appels et de budget effectifs d'un tour sur l'autre.
 */
export interface ContexteTourAgent {
  sessionId: string;
  runId: string;
  workflowId: string;
  waId: string;
  appelsDejaFaits: number;
  coutDejaMicroEur: number;
}

export interface AgentBrain {
  penser(input: {
    agentId: string;
    tenantId: string;
    /** L'historique de la conversation, tel que la session le porte. Opaque pour le tour. */
    transcript: unknown[];
    /** Échéance ABSOLUE (ms epoch) : le cerveau doit rendre la main avant, ou lever. */
    deadline: number;
    /** Absent pour un cerveau bouchonné, qui n'appelle aucun outil. */
    tour?: ContexteTourAgent;
  }): Promise<DecisionAgent>;
}
