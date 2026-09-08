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
  /** Ce que cet agent a consomme sur les `jours` derniers jours. */
  consommation?(tenantId: string, agentId: string, jours: number): Promise<ConsommationAgent>;
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
   *
   * ⚠️ Sa garde `status = 'en_cours'` n'est pas décorative : elle FENCE un tour périmé. Un porteur déchu qui
   * finit en retard ne peut pas effacer la marque posée par le balayage qui a repris sa session, puisque
   * celui-ci l'a d'abord close. C'est pour ça que la sortie due a sa propre méthode plutôt que de réutiliser
   * celle-ci : la garde qui protège l'une trahirait l'autre.
   */
  finirLeTour?(tenantId: string, sessionId: string): Promise<void>;

  /**
   * Efface la marque de tour en vol d'une session DÉJÀ CLOSE, une fois sa sortie appliquée au parcours.
   *
   * OPTIONNELLE, comme `finirLeTour` : un store de test qui ne la câble pas garde le comportement d'avant.
   *
   * Garde miroir de celle de `finirLeTour` : elle ne touche QUE les sessions closes. Un tour vivant ne peut
   * donc pas effacer par mégarde une marque qui désigne du travail restant.
   */
  sortieAppliquee?(tenantId: string, sessionId: string): Promise<void>;

  /**
   * Clôt la session. `sortie` porte le handle emprunté quand il y en a un.
   *
   * 🔴 `sortieDue` LAISSE LA MARQUE DE TOUR EN VOL, et c'est ce qui rend la transition terminale
   * réparable (contre-audit du 2026-09-03). Clore et faire sortir le parcours sont DEUX écritures : entre
   * elles, un crash laissait une session close et un parcours en attente pour toujours sur son bloc agent,
   * qu'aucun balayage ne pouvait plus voir, puisque la clôture effaçait justement le marqueur qui l'aurait
   * désigné. Avec `sortieDue`, l'état laissé par la panne est exactement celui que le balayage réclame.
   *
   * ⚠️ On clôt quand même AVANT de faire sortir, et l'ordre inverse serait un bug : `sortirDuBlocAgent`
   * fait AVANCER le parcours, qui peut retomber sur un autre bloc agent dans le même appel. `demarrerTourAgent`
   * réutilise alors la session vivante trouvée par `byRun`, avec ses tours et son budget déjà consommés, et
   * le nouvel agent serait muet dès son premier tour. La marque, elle, ne se réutilise pas : elle se répare.
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
   * 🔴 LA SORTIE RÉELLEMENT DUE, et elle n'était pas transportée (contre-contre-rapport du 2026-09-03).
   *
   * Le balayage sortait le parcours par `sortie:echec` EN DUR. C'était juste tant qu'il ne réclamait que des
   * sessions `en_cours`, qui n'ont par construction aucune sortie enregistrée. Depuis qu'il ramasse aussi les
   * sessions closes dont la sortie est restée due, c'est faux : deux des cinq sorties de `runTurn` écrivent
   * autre chose (le plafond, et surtout la sortie DÉCIDÉE par l'agent, qui est un code déclaré par le client).
   * Le contact repartait donc par le repli technique au lieu de la branche prévue, et c'est le cas le plus
   * fréquent, une conversation d'agent se terminant normalement bien plus souvent qu'elle n'échoue.
   *
   * ⚠️ **Elle rétablit aussi l'idempotence**, ce qui n'est pas un bonus mais la raison qui tranche : la
   * déduplication d'`advance` porte sur `agent:<session>:<sortie>`, donc un code différent DÉFAIT la
   * protection contre le rejeu. Reprendre avec le bon code, c'est reprendre avec la clé qui déduplique.
   *
   * Jamais nulle : la requête met la sortie forcée à la place quand la session était encore `en_cours`.
   */
  sortie: string;
}

/**
 * Ce qu'un agent a REELLEMENT consomme, sur une fenetre.
 *
 * 🔴 UNE MESURE, PAS UN PLAFOND, et c'est toute la difference que Julien a demandee le 2026-09-08 : « ce
 * qu'on veut, c'est un suivi du budget consomme au total en tokens pour le robot, et pas mettre un budget ».
 * Le plafond par conversation existe toujours et protege toujours (une boucle qui s'emballe s'arrete), il
 * n'a simplement rien a faire dans l'ecran ou l'on vient voir ce que l'agent a coute.
 */
export interface ConsommationAgent {
  /** Sessions comptees sur la fenetre. Une session est une conversation avec l'agent. */
  sessions: number;
  tokensEntree: number;
  tokensSortie: number;
  coutMicroEur: number;
  /** Le nombre de jours sur lesquels porte le compte, pour que l'ecran ne l'invente pas. */
  jours: number;
}
