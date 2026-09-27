/**
 * État d'une conversation tenue par le bloc agent, sur plusieurs tours.
 *
 * Le contrat est séparé de son implémentation Postgres pour que la boucle de tour puisse être testée
 * sans base (même raison que `Queue` / `FakeQueue`).
 */

/**
 * `en_cours` tant que l'agent tient le fil. Les quatre autres sont des fins, et elles se distinguent parce
 * qu'elles sortent du bloc par des handles différents : `sortie` (l'agent a conclu), `inactivite` (le contact
 * ne répond plus), `plafond` (tours, appels d'outils ou budget épuisés), `erreur` (repli).
 */
export type AgentSessionStatus = 'en_cours' | 'sortie' | 'inactivite' | 'plafond' | 'erreur';

export interface AgentSession {
  id: string;
  tenantId: string;
  runId: string;
  agentId: string;
  nodeId: string;
  waId: string;
  tours: number;
  appelsOutils: number;
  /**
   * Coût cumulé en micro-euros. `number` et non `bigint` : `JSON.stringify` lève sur un BigInt, et ce champ
   * finit dans une réponse d'API. 2^53 micro-euros font 9 milliards d'euros.
   */
  coutMicroEur: number;
  status: AgentSessionStatus;
  /**
   * Instant d'ouverture (ISO) : la borne basse de ce que l'agent lit de la conversation. Sans elle, un contact
   * ancien ferait payer tout son historique à chaque tour.
   */
  ouvertLe: string;
}

/**
 * 🔴 `tenantId` est exigé par chaque méthode, même celles qui connaissent déjà la session : la RLS est
 * contournée par le pooler, le filtrage en code est le seul contrôle d'isolation.
 */
export interface AgentSessionStore {
  /** Ce que cet agent a consommé sur les `jours` derniers jours. */
  consommation?(tenantId: string, agentId: string, jours: number): Promise<ConsommationAgent>;
  /** Les messages échangés dans les conversations que cet agent a tenues, sur une fenêtre de N jours. */
  messagesTenus?(tenantId: string, agentId: string, jours: number): Promise<number>;
  /**
   * Ouvre une session sur un parcours. Lève si ce parcours en a déjà une vivante : « une session par run » est
   * un index partiel en base, pas une convention de code.
   */
  open(input: { tenantId: string; runId: string; agentId: string; nodeId: string; waId: string }): Promise<AgentSession>;

  /** La session vivante d'un parcours, ou null. */
  byRun(tenantId: string, runId: string): Promise<AgentSession | null>;

  /**
   * Verrou optimiste : incrémente le tour si et seulement si `tours` vaut `toursAttendus`. Rend `null` quand
   * la ligne n'a pas bougé, ce qui vaut rejeu : pg-boss est at-least-once, et sans ce verrou un job périmé
   * enverrait un second message WhatsApp et rappellerait les outils.
   */
  prendreLeTour(tenantId: string, sessionId: string, toursAttendus: number): Promise<AgentSession | null>;

  /** Empile une entrée dans le transcript (message du contact, réponse du modèle, résultat d'outil). */
  ajouterAuTranscript(tenantId: string, sessionId: string, entree: unknown): Promise<void>;

  /**
   * Incrémente le compteur d'appels d'outils après chaque appel servi. Il rend effectif le plafond d'appels
   * d'un tour sur l'autre : sans lui, une injection qui fait boucler l'agent brûlerait le compte prépayé.
   */
  compterAppel(tenantId: string, sessionId: string): Promise<void>;

  /**
   * Ajoute le coût d'un tour au cumul de la session. 🔴 C'est ce cumul que `runTurn` compare au budget de la
   * fiche : sans lui, le plafond par conversation ne se déclencherait jamais. Incrémenté côté base, comme
   * `compterAppel` : deux écritures concurrentes ne s'écrasent pas, et un tour joué se compte même si la
   * session vient d'être close.
   */
  ajouterCout(tenantId: string, sessionId: string, montantMicroEur: number): Promise<void>;

  /**
   * Efface la marque de tour en vol posée par `prendreLeTour`, sur les sorties qui laissent la session vivante
   * (l'agent attend, ou un humain a pris la main). Optionnelle pour les stores de test.
   *
   * Sa garde `status = 'en_cours'` écarte un porteur périmé : il ne peut pas effacer la marque d'une session
   * que le balayage a reprise, puisque celui-ci l'a d'abord close. D'où une méthode distincte pour la sortie
   * due.
   */
  finirLeTour?(tenantId: string, sessionId: string): Promise<void>;

  /**
   * Efface la marque de tour en vol d'une session déjà close, une fois sa sortie appliquée au parcours.
   * Optionnelle. Garde miroir de `finirLeTour` : elle ne touche que les sessions closes.
   */
  sortieAppliquee?(tenantId: string, sessionId: string): Promise<void>;

  /**
   * Clôt la session. `sortie` porte le handle emprunté quand il y en a un.
   *
   * `sortieDue` laisse la marque de tour en vol : clore et faire sortir le parcours sont deux écritures, et
   * un crash entre les deux doit laisser un état que le balayage réclame. On clôt quand même avant de sortir :
   * `sortirDuBlocAgent` fait avancer le parcours, qui peut retomber sur un autre bloc agent et réutiliserait
   * alors la session encore vivante, tours et budget déjà consommés.
   */
  clore(
    tenantId: string,
    sessionId: string,
    status: AgentSessionStatus,
    sortie?: string,
    options?: { sortieDue?: boolean },
  ): Promise<void>;
}

/** Une session dont le tour est mort en vol, réclamée et close par le balayage. */
export interface TourBloque {
  sessionId: string;
  tenantId: string;
  runId: string;
  waId: string;
  nodeId: string;
  /**
   * La sortie réellement due, jamais `sortie:echec` en dur : le balayage ramasse aussi des sessions closes
   * dont la sortie (plafond, ou code décidé par l'agent) est restée due. C'est aussi la clé d'idempotence
   * d'`advance` (`agent:<session>:<sortie>`) : un autre code déferait la protection contre le rejeu. Jamais
   * nulle : la requête met la sortie forcée quand la session était encore `en_cours`.
   */
  sortie: string;
}

/**
 * Ce qu'un agent a réellement consommé, sur une fenêtre. Une mesure, pas un plafond : le plafond par
 * conversation existe toujours, il n'a rien à faire dans l'écran où l'on vient voir ce que l'agent a coûté.
 */
export interface ConsommationAgent {
  /** Sessions comptées sur la fenêtre. Une session est une conversation avec l'agent. */
  sessions: number;
  tokensEntree: number;
  tokensSortie: number;
  coutMicroEur: number;
  /** Le nombre de jours sur lesquels porte le compte, pour que l'écran ne l'invente pas. */
  jours: number;
}
