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
   * Coût cumulé en micro-euros. `number` et non `bigint` : le repo lit ses colonnes `bigint` en `string` puis
   * convertit (cf. `src/campaign/store.pg.ts`), et surtout `JSON.stringify` LÈVE sur un BigInt, alors que ce
   * champ finira dans une réponse d'API et dans un écran d'exploitation. Le micro-euro tient très large dans
   * un `number` (2^53 micro-euros = 9 milliards d'euros).
   */
  coutMicroEur: number;
  status: AgentSessionStatus;
  /**
   * Instant d'ouverture (ISO). C'est la BORNE BASSE de ce que l'agent lit de la conversation : il voit ce
   * qui s'est dit depuis qu'il a la main, et rien d'avant. Sans elle, un contact qui écrit depuis des mois
   * ferait payer tout son historique à chaque tour, et l'agent répondrait à des questions déjà traitées.
   */
  ouvertLe: string;
}

/**
 * ⚠️ `tenantId` est exigé par CHAQUE méthode, y compris celles qui connaissent déjà l'identifiant de session.
 * La connexion passe par le pooler en rôle superuser, donc la RLS est bypassée et le filtrage en code est le
 * SEUL contrôle d'isolation. L'appelant l'a toujours sous la main (il vient du job), ça ne coûte rien.
 */
export interface AgentSessionStore {
  /**
   * Ouvre une session sur un parcours. LÈVE si ce parcours en a déjà une vivante : l'invariant « une seule
   * session par run » est un index partiel en base (migration 0086), pas une convention de code.
   */
  open(input: { tenantId: string; runId: string; agentId: string; nodeId: string; waId: string }): Promise<AgentSession>;

  /** La session vivante d'un parcours, ou null. */
  byRun(tenantId: string, runId: string): Promise<AgentSession | null>;

  /**
   * Verrou optimiste : incrémente le tour SI ET SEULEMENT SI `tours` vaut `toursAttendus`.
   *
   * Rend `null` quand la ligne n'a pas bougé, ce qui vaut REJEU : le job doit sortir sans rien faire. pg-boss
   * est at-least-once, et un job d'inactivité différé peut se réveiller alors que le contact a déjà répondu.
   * Sans ce verrou, le rejeu enverrait un second message WhatsApp et rappellerait les outils.
   */
  prendreLeTour(tenantId: string, sessionId: string, toursAttendus: number): Promise<AgentSession | null>;

  /** Empile une entrée dans le transcript (message du contact, réponse du modèle, résultat d'outil). */
  ajouterAuTranscript(tenantId: string, sessionId: string, entree: unknown): Promise<void>;

  /**
   * Incrémente le compteur d'appels d'outils. Appelé par le tronc commun (`src/agent/executor.ts`) après
   * chaque appel servi.
   *
   * C'est ce compteur qui rend effectif le plafond d'appels lu par `runTurn` d'un tour sur l'autre : sans lui
   * la garde serait décorative, et une injection qui fait boucler l'agent sur ses outils brûlerait le compte
   * prépayé du tenant.
   */
  compterAppel(tenantId: string, sessionId: string): Promise<void>;

  /**
   * Ajoute le coût d'un tour au cumul de la session, en micro-euros.
   *
   * 🔴 SANS ELLE, LE PLAFOND PAR CONVERSATION EST DÉCORATIF. `runTurn` compare `session.coutMicroEur` au
   * budget de la fiche, mais rien n'écrivait jamais ce cumul : la colonne restait à zéro pour toujours, donc
   * la comparaison était toujours fausse et le réglage affiché dans la console ne se déclenchait jamais. Le
   * budget restant était bien appliqué À L'INTÉRIEUR d'un tour (une boucle d'outils emballée reste bornée),
   * mais d'un message à l'autre rien ne s'accumulait.
   *
   * Incrémenté côté BASE, comme `compterAppel` et pour la même raison : deux écritures concurrentes ne
   * peuvent pas s'écraser, et un tour déjà joué se compte même si la session vient d'être close.
   */
  ajouterCout(tenantId: string, sessionId: string, montantMicroEur: number): Promise<void>;

  /**
   * Efface la marque de tour en vol posée par `prendreLeTour` (migration 0112).
   *
   * OPTIONNELLE : un store de test qui ne la câble pas garde le comportement d'avant. Appelée sur les sorties
   * qui laissent la session VIVANTE (l'agent a répondu et attend, ou un humain a pris la main), donc les
   * seules que le balayage des tours bloqués pourrait confondre avec un crash.
   */
  finirLeTour?(tenantId: string, sessionId: string): Promise<void>;

  /** Clôt la session. `sortie` porte le handle emprunté quand il y en a un. */
  clore(tenantId: string, sessionId: string, status: AgentSessionStatus, sortie?: string): Promise<void>;
}

/** Une session dont le tour est mort en vol, réclamée et close par le balayage. */
export interface TourBloque {
  sessionId: string;
  tenantId: string;
  runId: string;
  waId: string;
  nodeId: string;
}
