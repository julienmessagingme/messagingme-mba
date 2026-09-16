import type { Pool } from 'pg';
import type { WorkflowGraph } from './graph';
import { parseGraph } from './graph';

/**
 * Relit le graphe figé d'un parcours. `null` = ce parcours n'en porte pas, le cas de TOUS les parcours réels.
 *
 * 🔴 UN REFUS SE DIT (seconde passe de revue finale, 2026-09-16). `parseGraph` rendait `null` sur un jsonb
 * qu'il refuse, et la lecture retombait alors sur le publié SANS UN MOT : c'est exactement le symptôme que
 * la migration 0151 répare, reproduit par sa propre garde. Ce dépôt énonce la règle inverse à deux pas d'ici
 * (`src/webhooks/test-token.ts`, « un chemin qui décide de NE PAS agir doit le dire »).
 *
 * ⚠️ POURQUOI `workflows.graph` ET `.draft_graph` NE SONT PAS PARSÉES, ELLES. Ces deux colonnes sont la
 * SOURCE : rien ne les écrit sans passer par `parseGraph` (`src/http/workflows.ts`), et si l'une d'elles
 * devenait illisible, la retomber sur autre chose n'aurait aucun sens, il n'y a pas d'« autre chose ». Ici
 * au contraire, le repli EXISTE et il est correct : on rejoue le publié. C'est cette asymétrie qui justifie
 * la garde d'un seul côté, pas un durcissement à moitié.
 */
function relireGrapheFige(brut: unknown, runId: string): WorkflowGraph | null {
  if (brut === null || brut === undefined) return null;
  const graphe = parseGraph(brut);
  if (graphe === null) {
    // eslint-disable-next-line no-console
    console.error(`workflow_runs ${runId}: graphe_fige illisible, le parcours retombe sur le scénario PUBLIÉ (il peut donc changer de version en cours de route)`);
  }
  return graphe;
}

/** `sleeping` = le run attend que le TEMPS passe (bloc Attente), `waiting` qu'un CONTACT réponde. */
export type RunStatus = 'waiting' | 'inbox' | 'done' | 'sleeping';

/**
 * Canal sur lequel la conversation se poursuit, PORTÉ PAR LE RUN (migration 0082).
 *
 * 🔴 Le canal n'est pas une propriété du bloc, c'est l'état du parcours. Un « message rapide » est un texte
 * avec des réponses en un tap : WhatsApp sait le faire, le RCS aussi. Le fixer au bloc obligeait à envoyer en
 * WhatsApp un message qui suit un échange RCS, alors que le contact n'a jamais écrit sur WhatsApp : Meta le
 * refuse (fenêtre de 24 h), et le parcours mourait là.
 *
 * La règle : un envoi RCS met le parcours sur `rcs`, un envoi de template le remet sur `whatsapp` (un template
 * est WhatsApp par nature, et c'est ainsi qu'on BASCULE volontairement de canal). Tout le reste suit.
 */
export type RunChannel = 'whatsapp' | 'rcs';

export interface WorkflowRunRow {
  id: string;
  workflowId: string;
  tenantId: string;
  waId: string;
  contactId?: string | null;
  currentNode: string | null;
  status: RunStatus;
  lastMessageId: string | null;
  /** Canal courant. Absent (ligne d'avant la migration) -> WhatsApp, le comportement historique. */
  channel?: RunChannel;
  /**
   * LE GRAPHE QUE CE PARCOURS JOUE, figé à son démarrage (migration 0151). `null` = on lit le publié.
   *
   * 🔴 RELUE PAR `parseGraph`, JAMAIS RENDUE TELLE QUELLE (correction de la revue finale, 2026-09-16). Ce
   * jsonb est une entrée que le code d'aujourd'hui ne contrôle pas : une ligne écrite par une version
   * antérieure, ou un objet arrivé par un chemin qu'on n'a pas prévu, partait droit dans
   * `graph.nodes.find(...)` sur le chemin chaud d'un message entrant. `parseGraph` rend `null` sur tout ce
   * qui n'est pas un graphe, ce qui fait retomber proprement sur le publié. C'est la règle du dépôt :
   * `safeParse`, jamais `as`, sur toute entrée non fiable.
   *
   * 🔴 REQUISE, JAMAIS OPTIONNELLE, et `null` est le cas NORMAL (aucun parcours réel n'en porte). Optionnelle,
   * un dépôt qui oublierait de la lire rendrait `undefined`, la préférence retomberait sur le publié, et on
   * retrouverait exactement le défaut qu'elle répare : un test qui change de version au premier bloc d'attente,
   * en silence. Le compilateur doit énumérer les lectures à compléter, c'est tout son intérêt ici.
   */
  grapheFige: WorkflowGraph | null;
}

export interface RunState {
  currentNode: string | null;
  status: RunStatus;
  lastMessageId?: string | null;
  /** Canal sur lequel la suite du parcours doit partir. Absent -> inchangé en base. */
  channel?: RunChannel;
  /** Échéance de reprise (statut `sleeping`). Absente -> la colonne est remise à NULL. */
  resumeAt?: Date | null;
}

/** Suivi des runs (exécution par contact) d'un workflow. Le webhook avance UN run en attente par (tenant, wa_id). */
export class PgWorkflowRunStore {
  constructor(private readonly pool: Pool) {}

  /**
   * `grapheFige` est un paramètre À PART, et pas un champ de `RunState` : il s'écrit UNE SEULE FOIS, à la
   * naissance du parcours. Le poser dans `RunState` l'aurait rendu acceptable par `setState`,
   * `setStateSiVivant` et `setStateSiEncoreSur`, qui l'auraient silencieusement ignoré : c'est le motif
   * « offert-et-inerte » que ce dépôt s'interdit ailleurs.
   */
  async start(tenantId: string, workflowId: string, waId: string, contactId: string | null, state: RunState, grapheFige: WorkflowGraph | null): Promise<{ id: string }> {
    // `resume_at` est écrit DÈS LA CRÉATION : un scénario dont le tout premier passage tombe sur un bloc
    // Attente naît directement en sommeil. L'omettre laissait un run `sleeping` SANS échéance, que le balayage
    // (qui exige `resume_at <= now()`) n'aurait jamais réveillé : parcours mort en silence.
    const res = await this.pool.query<{ id: string }>(
      `insert into workflow_runs (workflow_id, tenant_id, contact_id, wa_id, current_node, status, resume_at, channel, graphe_fige)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [workflowId, tenantId, contactId, waId, state.currentNode, state.status, state.resumeAt ?? null, state.channel ?? 'whatsapp',
       grapheFige === null ? null : JSON.stringify(grapheFige)],
    );
    return { id: res.rows[0]!.id };
  }

  /** LE run en attente d'un contact (par tenant + numéro). Un seul actif à la fois par contact (V1). */
  async findWaitingByWaId(tenantId: string, waId: string): Promise<WorkflowRunRow | null> {
    const res = await this.pool.query<{
      id: string; workflow_id: string; tenant_id: string; wa_id: string;
      current_node: string | null; status: 'waiting' | 'inbox' | 'done'; last_message_id: string | null;
      channel: RunChannel | null; graphe_fige: WorkflowGraph | null;
    }>(
      `select id, workflow_id, tenant_id, wa_id, current_node, status, last_message_id, channel, graphe_fige
       from workflow_runs where tenant_id = $1 and wa_id = $2 and status = 'waiting'
       order by created_at desc limit 1`,
      [tenantId, waId],
    );
    const r = res.rows[0];
    return r ? {
      id: r.id, workflowId: r.workflow_id, tenantId: r.tenant_id, waId: r.wa_id,
      currentNode: r.current_node, status: r.status, lastMessageId: r.last_message_id,
      channel: r.channel ?? 'whatsapp', grapheFige: relireGrapheFige(r.graphe_fige, r.id),
    } : null;
  }

  /**
   * UN run par son identifiant, quel que soit son statut.
   *
   * Sert la garde du tour d'agent : le job relit le run et exige qu'il attende toujours SUR SON bloc avant
   * d'envoyer quoi que ce soit. C'est ce qui rend inoffensif tout chemin qui tue un run `waiting` sans rien
   * savoir des sessions d'agent (lancement manuel depuis l'inbox, jeton de test, clôtures internes), y compris
   * ceux qui n'existent pas encore. D'où la lecture de TOUS les statuts, et pas seulement `waiting` : le tour
   * doit pouvoir DISTINGUER un run mort d'un run introuvable.
   */
  async byId(tenantId: string, id: string): Promise<WorkflowRunRow | null> {
    const res = await this.pool.query<{
      id: string; workflow_id: string; tenant_id: string; wa_id: string;
      current_node: string | null; status: RunStatus; last_message_id: string | null;
      channel: RunChannel | null; graphe_fige: WorkflowGraph | null;
    }>(
      `select id, workflow_id, tenant_id, wa_id, current_node, status, last_message_id, channel, graphe_fige
       from workflow_runs where tenant_id = $1 and id = $2`,
      [tenantId, id],
    );
    const r = res.rows[0];
    return r ? {
      id: r.id, workflowId: r.workflow_id, tenantId: r.tenant_id, waId: r.wa_id,
      currentNode: r.current_node, status: r.status, lastMessageId: r.last_message_id,
      channel: r.channel ?? 'whatsapp', grapheFige: relireGrapheFige(r.graphe_fige, r.id),
    } : null;
  }

  /**
   * Clôt TOUS les parcours encore actifs d'un contact (en attente d'une réponse, ou endormis sur un bloc
   * Attente) et rend combien ont été clos.
   *
   * 🔴 APPELÉE PAR `runFrom`, DONC PAR LES QUATRE CHEMINS DE DÉMARRAGE (Inbox, jeton de test, automation,
   * campagne et cible node), depuis le 2026-09-07. Elle ne servait avant qu'au lancement manuel depuis
   * l'Inbox, et c'est ce qui a changé son régime : d'un appel occasionnel à UN PAR DESTINATAIRE de campagne.
   * Deux choses en découlent, et se lisent ailleurs : la migration 0115 (aucun index ne servait sa clause),
   * et la garde de vivacité de `setStateSiVivant` (une course jusque-là quasi inatteignable).
   *
   * Sans elle, un second démarrage crée deux runs concurrents : `findWaitingByWaId` ne rend que le plus
   * récent (`limit 1`), donc le premier devient orphelin POUR TOUJOURS (aucun balayage ne nettoie un run
   * `waiting`), invisible, pendant que le contact reçoit les messages des deux.
   *
   * Règle posée par Julien : « on ne bloque personne sur un scénario, surtout quand on lance un nouveau
   * scénario ». Le nouveau remplace l'ancien, sans exception.
   */
  async closeActiveByWaId(tenantId: string, waId: string): Promise<string[]> {
    // `returning id` : l'appelant doit pouvoir clore les SESSIONS D'AGENT rattachées à ces parcours. Sans
    // elles, une session reste `en_cours` avec un tour jamais commencé, donc invisible de la reprise des
    // tours bloqués, jusqu'à la purge de rétention. Rare tant que la fermeture était un geste d'opérateur,
    // ordinaire depuis qu'elle a lieu par destinataire de campagne.
    const res = await this.pool.query<{ id: string }>(
      `update workflow_runs set status = 'done', current_node = null, resume_at = null, updated_at = now()
       where tenant_id = $1 and wa_id = $2 and status in ('waiting', 'sleeping')
       returning id`,
      [tenantId, waId],
    );
    return res.rows.map((r) => r.id);
  }

  /**
   * Écrit l'état d'un run SEULEMENT s'il attend encore sur le bloc qu'on croit. Rend `false` si rien n'a bougé.
   *
   * 🔴 POURQUOI CETTE VARIANTE EXISTE. Un tour d'agent dure 3 à 30 secondes, et il écrit son état à la fin.
   * Entre-temps, le run peut avoir été TUÉ : TOUT démarrage de scénario appelle `closeActiveByWaId`, qui
   * passe le run en `done`, et en crée un autre. ⚠️ Ce n'était le fait que du lancement manuel depuis
   * l'Inbox jusqu'au 2026-09-07 ; c'est désormais le passage commun des quatre chemins, campagnes comprises,
   * donc cette course est passée de rare à ordinaire. Un `setState` inconditionnel le
   * ressusciterait en `waiting` AVEC une échéance : invisible de `findWaitingByWaId` (le nouveau run est plus
   * récent), mais parfaitement visible de `claimDueQuestions`, qui déclencherait plus tard la branche
   * « pas de réponse » d'un parcours que quelqu'un avait délibérément fermé, en parallèle du nouveau.
   *
   * C'est le pendant, côté ÉCRITURE, de la garde que le tour applique déjà en lecture : « le run attend-il
   * toujours sur CE bloc ». Même motif de verrou optimiste que `prendreLeTour` et `claimDueQuestions`.
   */
  /**
   * RÉSERVE LE TOUR D'AVANCE d'un parcours, AVANT tout envoi (migration 0104).
   *
   * 🔴 C'est ce qui ferme le double envoi. `setStateSiEncoreSur` protège l'ÉTAT mais arrive APRÈS les
   * envois : deux avances concurrentes envoyaient toutes les deux, et seule la seconde écriture était
   * refusée. Le contact recevait donc deux messages, dont un qu'il ne devait jamais voir.
   *
   * Rend `null` quand un autre traitement tient déjà le tour : l'appelant doit alors sortir SANS RIEN FAIRE.
   * C'est la même convention que `prendreLeTour` d'une session d'agent, et pour la même raison.
   *
   * Les trois pièces d'un vrai verrou :
   * - le BAIL (`avance_jusqu_a`) : un worker tué en plein traitement ne bloque pas le parcours à vie ;
   * - le JETON, rendu à l'appelant, qui seul permet de libérer : un porteur de bail périmé ne peut pas
   *   libérer le verrou de celui qui l'a repris entre-temps ;
   * - la garde sur `current_node`, qui refuse le tour si le parcours a bougé pendant qu'on lisait.
   */
  async reserverAvance(tenantId: string, id: string, nodeId: string | null, bailSecondes: number): Promise<string | null> {
    const res = await this.pool.query<{ avance_token: string }>(
      `update workflow_runs
          set avance_token = gen_random_uuid(),
              avance_jusqu_a = now() + make_interval(secs => $4::double precision)
        where id = $1 and tenant_id = $2 and status = 'waiting'
          and current_node is not distinct from $3
          and (avance_jusqu_a is null or avance_jusqu_a <= now())
        returning avance_token`,
      [id, tenantId, nodeId, bailSecondes],
    );
    return res.rows[0]?.avance_token ?? null;
  }

  /**
   * PROLONGE le bail tant que l'avance travaille (lot 1 du plan post-audit, 2026-09-02).
   *
   * 🔴 C'est la pièce qui distingue « porteur mort » de « porteur LENT ». Sans elle, une avance plus longue
   * que le bail (~154 s au pire pour un seul envoi Meta qui rejoue ses tentatives) voyait son tour repris par
   * une autre, et les deux envoyaient. Aucune valeur de bail ne pouvait fermer ça : le nombre d'envois d'une
   * avance n'est pas borné. Cf. `bail-avance.ts` pour la cadence et pourquoi c'est un tiers du bail.
   *
   * Le JETON est la seule garde, volontairement SANS condition sur `avance_jusqu_a` : si notre bail a expiré
   * mais que personne ne l'a repris, le jeton est encore le nôtre et on a le droit de le reprolonger. C'est
   * exactement le cas qu'on veut soigner, un battement arrivé en retard. Si un autre l'a repris, le jeton a
   * changé, la requête ne touche aucune ligne, et `false` remonte jusqu'au battement qui s'arrête.
   */
  async prolongerAvance(id: string, token: string, bailSecondes: number): Promise<boolean> {
    const res = await this.pool.query(
      `update workflow_runs
          set avance_jusqu_a = now() + make_interval(secs => $3::double precision)
        where id = $1 and avance_token = $2`,
      [id, token, bailSecondes],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Rend le tour. Le JETON est dans le `where` : un porteur de bail périmé, revenu tard, ne peut pas libérer
   * le verrou de celui qui l'a repris. Sans ça, un traitement lent ferait sauter la garde d'un autre.
   *
   * Best-effort chez l'appelant : ne pas réussir à libérer coûte au pire l'attente du bail.
   */
  async libererAvance(id: string, token: string): Promise<void> {
    await this.pool.query(
      `update workflow_runs set avance_token = null, avance_jusqu_a = null where id = $1 and avance_token = $2`,
      [id, token],
    );
  }

  /**
   * 🔴 Le JETON est dans la garde depuis le lot 1 du plan post-audit (2026-09-02). Avant, cette écriture
   * filtrait sur `id`, `tenant_id`, `status` et `current_node`, jamais sur `avance_token` : un porteur de bail
   * PÉRIMÉ, revenu tard, pouvait donc encore écrire l'état par-dessus celui qui avait repris le tour. La
   * réservation protégeait les envois, l'écriture restait ouverte.
   *
   * `token` à `null` = aucune réservation n'a eu lieu (câblages de test, e2e, tout store qui ne pose pas
   * `reserverAvance`). La garde retombe alors sur son comportement d'avant plutôt que de refuser toute
   * écriture, ce qui figerait ces parcours. Le `is null` est porté par le PARAMÈTRE, pas par la colonne : un
   * appelant qui tient un jeton est toujours confronté au jeton de la ligne.
   */
  async setStateSiEncoreSur(tenantId: string, id: string, nodeId: string | null, state: RunState, token: string | null = null): Promise<boolean> {
    const res = await this.pool.query(
      `update workflow_runs set current_node = $4, status = $5,
              last_message_id = coalesce($6, last_message_id), resume_at = $7,
              channel = coalesce($8, channel), updated_at = now()
        -- « is not distinct from » et non « = » : un run peut légitimement attendre AVEC current_node à
        -- null (parcours sans position, clôture). Avec « = », null = null vaut NULL, donc la garde ne
        -- trouvait jamais la ligne et l'écriture était silencieusement PERDUE. Pour toute valeur non nulle,
        -- les deux opérateurs sont identiques : la garde n'est pas affaiblie.
        where id = $1 and tenant_id = $2 and status = 'waiting' and current_node is not distinct from $3
          and ($9::uuid is null or avance_token = $9::uuid)`,
      [id, tenantId, nodeId, state.currentNode, state.status, state.lastMessageId ?? null, state.resumeAt ?? null, state.channel ?? null, token],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Écrit l'état d'un run SEULEMENT s'il est encore VIVANT (`waiting` ou `sleeping`). Rend `false` s'il a été
   * clos entre-temps.
   *
   * 🔴 CE QUE ÇA FERME, ET POURQUOI SEULEMENT MAINTENANT. `setState` écrit sur `where id = $1`, sans regarder
   * l'état. La reprise d'un parcours endormi (`resume`) l'appelle À LA FIN, après ses envois, qui prennent du
   * temps. Entre le moment où le balayage réclame le run et celui où la reprise écrit, un autre chemin peut
   * avoir appelé `closeActiveByWaId` : la reprise réécrit alors `waiting`/`sleeping` AVEC une échéance sur un
   * run passé à `done`. Il devient invisible de `findWaitingByWaId` (qui ne rend que le plus récent) mais
   * reste parfaitement réveillable par les balayages, et parle au client depuis un scénario abandonné.
   *
   * ⚠️ Ce n'était pas atteignable en pratique tant que la fermeture n'était appelée que par un lancement
   * manuel depuis l'Inbox, quelques fois par jour. Depuis le 2026-09-07, elle l'est UNE FOIS PAR DESTINATAIRE
   * de campagne. C'est le cas d'école du CLAUDE.md : élargir le domaine d'une réparation oblige à relire ce
   * qu'elle supposait.
   *
   * Même famille que `setStateSiEncoreSur`, qui ferme la même course pour `advance` : là-bas la garde porte
   * sur le BLOC attendu, ici sur le fait que le parcours vive encore, parce qu'une reprise change de bloc par
   * construction.
   */
  async setStateSiVivant(tenantId: string, id: string, state: RunState): Promise<boolean> {
    const res = await this.pool.query(
      `update workflow_runs set current_node = $3, status = $4, last_message_id = coalesce($5, last_message_id),
              resume_at = $6, channel = coalesce($7, channel), updated_at = now()
       where id = $1 and tenant_id = $2 and status in ('waiting', 'sleeping')`,
      [id, tenantId, state.currentNode, state.status, state.lastMessageId ?? null, state.resumeAt ?? null, state.channel ?? null],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setState(id: string, state: RunState): Promise<void> {
    // `resume_at` est écrit SANS coalesce : quitter le sommeil doit effacer l'échéance, sinon un run réveillé
    // resterait éligible au balayage suivant.
    await this.pool.query(
      // `channel` avec coalesce, à l'inverse de `resume_at` : un état écrit SANS canal (une clôture, une
      // remontée en inbox) ne doit pas ramener le parcours sur WhatsApp par omission.
      `update workflow_runs set current_node = $2, status = $3, last_message_id = coalesce($4, last_message_id),
              resume_at = $5, channel = coalesce($6, channel), updated_at = now()
       where id = $1`,
      [id, state.currentNode, state.status, state.lastMessageId ?? null, state.resumeAt ?? null, state.channel ?? null],
    );
  }

  /**
   * CLAIM des runs dormants DUS : passe `sleeping` -> `waiting` et rend les lignes prises, en UNE requête.
   *
   * L'update et la sélection sont indissociables : deux workers qui balaient en même temps ne peuvent pas
   * prendre la même ligne (le second ne la voit plus en `sleeping`). Un `select` puis `update` séparés
   * réveilleraient le même parcours deux fois, donc enverraient le message en double.
   *
   * Statut de sortie `waiting` : le run redevient un parcours normal, et si la reprise échoue (worker tué en
   * plein vol) il ne dort pas éternellement, il est simplement en attente comme après un envoi.
   */
  async claimDueSleeping(limit: number): Promise<WorkflowRunRow[]> {
    const res = await this.pool.query<{
      id: string; workflow_id: string; tenant_id: string; wa_id: string; contact_id: string | null;
      current_node: string | null; last_message_id: string | null; channel: RunChannel | null;
      graphe_fige: WorkflowGraph | null;
    }>(
      // BAIL, pas changement de statut : on repousse l'échéance en RESTANT `sleeping` (durée fixée plus bas).
      //  - passer à `waiting` mettrait le run à portée de `findWaitingByWaId`, donc de `advance` : un message
      //    du contact pendant la reprise rejouerait le MÊME bloc suivant et enverrait le message deux fois ;
      //  - et un worker tué après le claim laisserait un run `waiting` figé sur le bloc Attente, indiscernable
      //    d'un run sain, que n'importe quel message ultérieur ressusciterait (y compris après l'envoi).
      // Avec le bail : les autres workers ne voient plus la ligne comme due, `advance` ne la voit pas du tout,
      // et un worker tué la rend simplement due à nouveau à l'expiration du bail.
      //
      // `created_at` borné : deux blocs Attente qui se pointent l'un l'autre relanceraient un sommeil à chaque
      // réveil, pour toujours. Au-delà de 90 jours on cesse de réveiller (le sweeper clôt ces runs à part).
      // INVARIANT du bail : il doit couvrir la reprise de TOUT un lot (`batchSize`, 50 par défaut) au pire cas,
      // relances Meta comprises (withRetry + Retry-After). À 5 minutes, un incident Meta suffisait à le faire
      // expirer avant la fin du lot : la passe suivante re-claimait les derniers runs et DEUX reprises
      // tournaient en parallèle sur le même parcours. 15 minutes, plus la garde de ré-entrance du sweeper.
      `update workflow_runs r set resume_at = now() + interval '15 minutes', updated_at = now()
       from (
         select id from workflow_runs
         where status = 'sleeping' and resume_at is not null and resume_at <= now()
           and created_at > now() - interval '90 days'
         order by resume_at
         for update skip locked
         limit $1
       ) due
       where r.id = due.id
       returning r.id, r.workflow_id, r.tenant_id, r.wa_id, r.contact_id, r.current_node, r.last_message_id, r.channel, r.graphe_fige`,
      [limit],
    );
    return res.rows.map((r) => ({
      id: r.id, workflowId: r.workflow_id, tenantId: r.tenant_id, waId: r.wa_id, contactId: r.contact_id,
      currentNode: r.current_node, status: 'sleeping' as const, lastMessageId: r.last_message_id, channel: r.channel ?? 'whatsapp', grapheFige: parseGraph(r.graphe_fige),
    }));
  }

  /**
   * Réclame les parcours qui ATTENDENT UNE RÉPONSE et dont le délai « pas de réponse » a expiré (bloc
   * Question). Miroir de `claimDueSleeping`, avec une différence de fond dans la façon de réclamer.
   *
   * MÊME BAIL que `claimDueSleeping`, et c'est la seule chose sûre. Une première version CONSOMMAIT
   * l'échéance (`resume_at = null`) pour garantir qu'une expiration n'est prise qu'une fois. Elle garantissait
   * surtout qu'une reprise ratée la perdait POUR TOUJOURS : un refus de Meta, un worker redéployé au mauvais
   * moment, et le parcours restait `waiting` sur sa question, sans échéance, avec le fil tenu par un run mort
   * que plus rien ne réveille et que `closeStaleSleeping` ne voit pas (il ne regarde que les dormants).
   *
   * Le bail rend la reprise REJOUABLE sans rien perdre de l'exclusivité : les autres passes ne voient plus la
   * ligne comme due, et une reprise interrompue redevient due 15 minutes plus tard.
   *
   * Ce qui efface l'échéance pour de bon, c'est la reprise elle-même : TOUTES les sorties de
   * `WorkflowExecutor.resume` passent par `setState`, qui écrit `resume_at` SANS coalesce.
   *
   * ⚠️ Différence de fond avec le sommeil, et elle est voulue : le run reste `waiting`, donc `advance` le voit
   * pendant toute la reprise. Une réponse du contact peut le reprendre à tout instant, y compris juste après
   * la réclamation. C'est le prix à payer pour ne jamais avaler une réponse de client, et l'ordre inverse
   * (réponse PUIS échéance) est sûr de toute façon, `advance` effaçant `resume_at` en réécrivant l'état.
   */
  async claimDueQuestions(limit: number): Promise<WorkflowRunRow[]> {
    const res = await this.pool.query<{
      id: string; workflow_id: string; tenant_id: string; wa_id: string; contact_id: string | null;
      current_node: string | null; last_message_id: string | null; channel: RunChannel | null;
      graphe_fige: WorkflowGraph | null;
    }>(
      // Même borne de 90 jours que le sommeil : au-delà, un parcours n'a plus de sens métier, et la fenêtre
      // de service est de toute façon fermée depuis longtemps. Même durée de bail, aussi : elle doit couvrir
      // la reprise de TOUT un lot au pire cas, relances Meta comprises.
      `update workflow_runs r set resume_at = now() + interval '15 minutes', updated_at = now()
       from (
         select id from workflow_runs
         where status = 'waiting' and resume_at is not null and resume_at <= now()
           and created_at > now() - interval '90 days'
         order by resume_at
         for update skip locked
         limit $1
       ) due
       where r.id = due.id
       returning r.id, r.workflow_id, r.tenant_id, r.wa_id, r.contact_id, r.current_node, r.last_message_id, r.channel, r.graphe_fige`,
      [limit],
    );
    return res.rows.map((r) => ({
      id: r.id, workflowId: r.workflow_id, tenantId: r.tenant_id, waId: r.wa_id, contactId: r.contact_id,
      currentNode: r.current_node, status: 'waiting' as const, lastMessageId: r.last_message_id, channel: r.channel ?? 'whatsapp', grapheFige: parseGraph(r.graphe_fige),
    }));
  }

  /**
   * Clôt les parcours dormants trop vieux. `created_at` est l'âge du RUN, pas du sommeil : ce que ça clôt
   * surtout, c'est un parcours ABANDONNÉ (né il y a longtemps, réveillé tard), et accessoirement une chaîne
   * d'attentes qui se rendort sans fin. Cohérent avec la doctrine maison, qui considère déjà un run `waiting`
   * abandonné au bout de 7 jours. Rend le nombre de parcours clos.
   */
  async closeStaleSleeping(maxAgeDays = 90): Promise<number> {
    const res = await this.pool.query(
      `update workflow_runs set status = 'done', resume_at = null, updated_at = now()
       where status = 'sleeping' and created_at <= now() - make_interval(days => $1)`,
      [maxAgeDays],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Purge les parcours TERMINÉS plus vieux que la rétention.
   *
   * 🔴 UN PARCOURS VIVANT N'EST JAMAIS EFFACÉ, quel que soit son âge. Le filtre porte sur les statuts
   * terminaux (`done`, `inbox`), et l'index partiel de la migration 0097 porte le même : la garde est donc
   * posée deux fois, en base et dans la requête. Un run `waiting` ou `sleeping` vieux d'un an est une anomalie
   * à corriger ailleurs, sûrement pas une ligne à supprimer en silence sous les pieds d'un contact.
   *
   * Ce que ça ferme : ces lignes portent le `wa_id` du contact (donnée personnelle) et ne sont plus lues par
   * personne une fois le parcours fini. Aucun écran, aucun rapport ne les relit : seule l'exécution interroge
   * cette table, et elle ne cherche que des parcours vivants.
   */
  async purgeTerminesOlderThan(days: number, maxParPassage = 50_000): Promise<number> {
    if (days <= 0) return 0;
    const res = await this.pool.query(
      `delete from workflow_runs
        where id in (
          select id from workflow_runs
           where status in ('done', 'inbox') and updated_at < now() - make_interval(days => $1)
           limit $2
        )`,
      [Math.floor(days), Math.max(1, maxParPassage)],
    );
    return res.rowCount ?? 0;
  }
}
