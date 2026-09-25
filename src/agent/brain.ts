import { texteDe } from '../lib/erreur';
/**
 * Le « cerveau » d'un tour d'agent : ce qui transforme un historique de conversation en une décision.
 *
 * Séparé derrière un contrat pour une raison précise : le chemin chaud (le tour, ses gardes, ses plafonds,
 * ses sorties) se teste et se durcit SANS réseau ni modèle, avec un cerveau bouchonné. Le vrai client
 * remplace le fake sans toucher au reste.
 */

/**
 * Ce qu'un tour a consommé. `coutMicroEur` est un `number` et non un `bigint`, pour la même raison qu'en base
 * (`session-store.ts`) : `JSON.stringify` LÈVE sur un BigInt, et ce chiffre finit dans une réponse d'API.
 */
export interface UsageTour {
  tokensIn: number;
  tokensOut: number;
  coutMicroEur: number;
}

/**
 * Un tour a échoué APRÈS qu'un appel de modèle a déjà été facturé.
 *
 * 🔴 SANS ELLE, UNE CONSOMMATION RÉELLE DISPARAÎT. Un tour fait plusieurs allers-retours (le modèle appelle un
 * outil, lit son résultat, reparle) et chacun est facturé séparément par le fournisseur. Si le deuxième échoue
 * (panne, 4xx terminal, échéance dépassée), une exception nue emporterait avec elle ce que le premier a déjà
 * coûté : ni le compteur de la session ni le solde prépayé du workspace ne bougeraient, alors que la facture
 * du fournisseur, elle, est bien partie. Le contrat est donc : un cerveau qui lève après avoir dépensé lève
 * CECI, et l'appelant enregistre `usage` avant de traiter l'échec.
 *
 * Elle vit ici, dans le CONTRAT, et non dans l'implémentation Gateway : c'est l'appelant du contrat qui doit
 * la reconnaître, et l'y mettre ferait dépendre le tour d'une implémentation particulière du cerveau.
 */
export class TourInterrompu extends Error {
  constructor(readonly erreur: unknown, readonly usage: UsageTour) {
    super(texteDe(erreur));
    this.name = 'TourInterrompu';
  }
}

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
  /** Consommation du tour. Absente pour un cerveau bouchonné, qui ne consomme rien. */
  usage?: UsageTour;
  /**
   * CE TOUR vient lui-même de passer le fil à un humain (escalade), et il l'a fait à l'instant.
   *
   * 🔴 ELLE EXISTE PARCE QUE LA GARDE DE DÉTENTEUR DU TOUR DEVIENT FAUSSE DU FAIT DE CETTE ESCALADE
   * (revue du 2026-09-18). `run-turn` refuse d'envoyer dès que le fil n'est plus `app_workflow`, ce qui
   * protège d'un opérateur qui aurait repris la conversation pendant les secondes du modèle. Mais
   * l'escalade bascule elle-même ce détenteur, donc la garde s'armait contre nous et jetait en silence la
   * dernière phrase de l'agent, celle qui dit au contact que l'équipe est fermée.
   *
   * ⚠️ ELLE VIENT DE L'ÉCRITURE, PAS D'UNE RELECTURE. `setControlOwner` rend `true` seulement s'il a
   * vraiment basculé `app_workflow` vers `app_human` : un opérateur qui avait déjà la main rend `false`,
   * et le tour se tait, comme avant. Relire le détenteur ici rouvrirait exactement la course qu'on ferme.
   */
  mainPriseParCeTour?: boolean;
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
