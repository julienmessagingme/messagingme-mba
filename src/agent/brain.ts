import { texteDe } from '../lib/erreur';
/**
 * Le « cerveau » d'un tour d'agent : ce qui transforme un historique de conversation en une décision.
 * Derrière un contrat pour que le tour (gardes, plafonds, sorties) se teste sans réseau ni modèle.
 */

/**
 * Ce qu'un tour a consommé. `coutMicroEur` est un `number` et non un `bigint` : `JSON.stringify` lève sur un
 * BigInt, et ce chiffre finit dans une réponse d'API.
 */
export interface UsageTour {
  tokensIn: number;
  tokensOut: number;
  coutMicroEur: number;
}

/**
 * Un tour a échoué après qu'un appel de modèle a déjà été facturé.
 *
 * 🔴 Chaque aller-retour d'un tour est facturé par le fournisseur : une exception nue après le premier
 * emporterait ce qu'il a coûté, sans toucher ni la session ni le solde. Un cerveau qui lève après avoir
 * dépensé lève donc ceci, et l'appelant enregistre `usage` avant de traiter l'échec. Dans le contrat, pas
 * dans l'implémentation Gateway, puisque c'est l'appelant du contrat qui la reconnaît.
 */
export class TourInterrompu extends Error {
  constructor(readonly erreur: unknown, readonly usage: UsageTour) {
    super(texteDe(erreur));
    this.name = 'TourInterrompu';
  }
}

export interface DecisionAgent {
  /**
   * Texte à envoyer au contact. `null` = ne rien envoyer, quand c'est le bloc aval qui parle (escalade,
   * reprise du scénario) : pas un échec.
   */
  texte: string | null;
  /**
   * Code de la sortie empruntée, sans son préfixe (`fini`, `escalade`...), ou `null` si l'agent a posé une
   * question et attend la réponse du contact. `null` laisse le parcours en attente sur le bloc.
   */
  sortie: string | null;
  /** Consommation du tour. Absente pour un cerveau bouchonné, qui ne consomme rien. */
  usage?: UsageTour;
  /**
   * Ce tour vient lui-même de passer le fil à un humain (escalade).
   *
   * `run-turn` refuse d'envoyer dès que le fil n'est plus `app_workflow` (un opérateur a pu reprendre la
   * main) ; sans ce drapeau, notre propre escalade jetterait la dernière phrase de l'agent. Il vient de
   * l'écriture (`setControlOwner` rend `true` seulement s'il a basculé), jamais d'une relecture du détenteur,
   * qui rouvrirait la course.
   */
  mainPriseParCeTour?: boolean;
  /**
   * Un outil vient de lancer un scénario qui a pris la conversation (`mba_lancer_scenario`, RC4) : la session est
   * close et le parcours de l'agent fini. `run-turn` s'arrête là, sans rien envoyer, sans poser d'échéance et sans
   * faire sortir le bloc : aucune sortie du bloc agent ne repart derrière le scénario lancé.
   */
  scenarioLance?: boolean;
}

/**
 * Où en est ce tour, pour un cerveau qui appelle des outils.
 *
 * 🔴 Passé à l'appel, jamais figé à la construction : un worker sert tous les clients avec un seul cerveau,
 * et un contexte figé ferait exécuter les outils du contact A dans la conversation de B. Les compteurs
 * viennent de la session, relue à chaque tour, et rendent les plafonds effectifs d'un tour sur l'autre.
 */
export interface ContexteTourAgent {
  sessionId: string;
  runId: string;
  workflowId: string;
  waId: string;
  appelsDejaFaits: number;
  coutDejaMicroEur: number;
  /**
   * L'ouverture de la session (ISO). La mémoire du tour déborde la session (`MEMOIRE_JOURS`, `src/agent/run-turn.ts`) ;
   * l'annonce d'IA « une fois par session » ne compte que les entrées datées de ce moment ou après. Absente (le bac à
   * sable, dont la conversation entière EST la session) : tout le transcript compte.
   */
  sessionOuverteLe?: string;
  /**
   * Ce parcours est le répondeur de l'espace (le scénario système, lot 5) : aucune branche ne parle après une escalade
   * (son graphe relie `humain` à une fin muette, `src/repondeur/graphe.ts`), la dernière phrase de l'agent est donc la
   * seule que le contact recevra. `false` dans un scénario du client et dans le bac à sable.
   */
  repondeur: boolean;
}

export interface AgentBrain {
  penser(input: {
    agentId: string;
    tenantId: string;
    /** L'historique de la conversation, tel que la session le porte. Opaque pour le tour. */
    transcript: unknown[];
    /** Échéance absolue (ms epoch) : le cerveau doit rendre la main avant, ou lever. */
    deadline: number;
    /** Absent pour un cerveau bouchonné, qui n'appelle aucun outil. */
    tour?: ContexteTourAgent;
  }): Promise<DecisionAgent>;
}
