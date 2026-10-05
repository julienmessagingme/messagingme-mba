import type { Pool } from 'pg';
import type { WorkflowGraph } from './graph';
import { parseGraph } from './graph';

/**
 * Relit le graphe figé d'un parcours. `null` = ce parcours n'en porte pas, le cas de tous les parcours réels.
 *
 * Un refus de `parseGraph` se journalise : sinon la lecture retomberait sur le publié sans un mot. Seul ce
 * jsonb est reparsé : `workflows.graph` et `.draft_graph` sont la source (écrites via `parseGraph`), sans
 * repli possible, alors qu'ici le repli sur le publié existe et est correct.
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

/** Une ligne de `workflow_runs` telle que la lisent `findWaitingByWaId` et `byId`. */
interface LigneRun {
  id: string; workflow_id: string; tenant_id: string; wa_id: string;
  current_node: string | null; status: RunStatus; last_message_id: string | null;
  channel: RunChannel | null; graphe_fige: WorkflowGraph | null;
}

function runDeLigne(r: LigneRun): WorkflowRunRow {
  return {
    id: r.id, workflowId: r.workflow_id, tenantId: r.tenant_id, waId: r.wa_id,
    currentNode: r.current_node, status: r.status, lastMessageId: r.last_message_id,
    channel: r.channel ?? 'whatsapp', grapheFige: relireGrapheFige(r.graphe_fige, r.id),
  };
}

/** `sleeping` = le run attend que le temps passe (bloc Attente), `waiting` qu'un contact réponde. */
export type RunStatus = 'waiting' | 'inbox' | 'done' | 'sleeping';

/**
 * Canal sur lequel la conversation se poursuit, porté par le run et non par le bloc : un message rapide
 * existe en WhatsApp comme en RCS, et l'envoyer en WhatsApp après un échange RCS serait refusé par Meta
 * (fenêtre de 24 h). Un envoi RCS met le parcours sur `rcs`, un envoi de template le remet sur `whatsapp`
 * (c'est ainsi qu'on bascule volontairement). Tout le reste suit.
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
  /** Canal courant. Absent (ligne ancienne) -> WhatsApp. */
  channel?: RunChannel;
  /**
   * Le graphe que ce parcours joue, figé à son démarrage. `null` = on lit le publié (le cas normal).
   *
   * Relu par `parseGraph`, jamais rendu tel quel : ce jsonb est une entrée non fiable, et `parseGraph` rend
   * `null` sur tout ce qui n'est pas un graphe (retour propre au publié). Requis et non optionnel : un store
   * qui oublierait de le lire rendrait `undefined`, et un parcours de test changerait de version en silence.
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

/** Suivi des runs (exécution par contact) d'un workflow. Le webhook avance un run en attente par (tenant, wa_id). */
export class PgWorkflowRunStore {
  constructor(private readonly pool: Pool) {}

  /**
   * `grapheFige` est un paramètre à part, pas un champ de `RunState` : il s'écrit une seule fois, à la
   * naissance du parcours, et `setState` et ses variantes l'auraient ignoré en silence.
   */
  async start(tenantId: string, workflowId: string, waId: string, contactId: string | null, state: RunState, grapheFige: WorkflowGraph | null): Promise<{ id: string }> {
    // `resume_at` est écrit dès la création : un scénario dont le premier passage tombe sur un bloc Attente
    // naît en sommeil, et sans échéance le balayage (`resume_at <= now()`) ne le réveillerait jamais.
    // `last_message_id` aussi : le message qui démarre un parcours (le répondeur) y naît déjà reçu, et sa redélivrance
    // par Meta n'est pas prise pour une réponse par `advance`. Absent, `null` : le cas de tous les autres démarrages.
    const res = await this.pool.query<{ id: string }>(
      `insert into workflow_runs (workflow_id, tenant_id, contact_id, wa_id, current_node, status, resume_at, channel, graphe_fige, last_message_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [workflowId, tenantId, contactId, waId, state.currentNode, state.status, state.resumeAt ?? null, state.channel ?? 'whatsapp',
       grapheFige === null ? null : JSON.stringify(grapheFige), state.lastMessageId ?? null],
    );
    return { id: res.rows[0]!.id };
  }

  /** Le run en attente d'un contact (par tenant + numéro). Un seul actif à la fois par contact. */
  async findWaitingByWaId(tenantId: string, waId: string): Promise<WorkflowRunRow | null> {
    const res = await this.pool.query<LigneRun>(
      `select id, workflow_id, tenant_id, wa_id, current_node, status, last_message_id, channel, graphe_fige
       from workflow_runs where tenant_id = $1 and wa_id = $2 and status = 'waiting'
       order by created_at desc limit 1`,
      [tenantId, waId],
    );
    const r = res.rows[0];
    return r ? runDeLigne(r) : null;
  }

  /**
   * Un run par son identifiant, quel que soit son statut. Sert la garde du tour d'agent, qui exige que le run
   * attende toujours sur son bloc avant d'envoyer : c'est ce qui rend inoffensif tout chemin qui tue un run
   * `waiting` sans rien savoir des sessions d'agent. Tous les statuts, pour distinguer un run mort d'un run
   * introuvable.
   */
  async byId(tenantId: string, id: string): Promise<WorkflowRunRow | null> {
    const res = await this.pool.query<LigneRun>(
      `select id, workflow_id, tenant_id, wa_id, current_node, status, last_message_id, channel, graphe_fige
       from workflow_runs where tenant_id = $1 and id = $2`,
      [tenantId, id],
    );
    const r = res.rows[0];
    return r ? runDeLigne(r) : null;
  }

  /**
   * Clôt tous les parcours encore actifs d'un contact (`waiting` ou `sleeping`) et rend leurs identifiants.
   *
   * Appelée par `runFrom`, donc par tous les chemins de démarrage, campagnes comprises (une fois par
   * destinataire ; la migration 0115 porte l'index qui sert sa clause). Le nouveau parcours remplace l'ancien,
   * sans exception. Sans elle, deux runs coexistent : `findWaitingByWaId` ne rend que le plus récent, l'autre
   * devient orphelin pour toujours pendant que le contact reçoit les messages des deux.
   */
  async closeActiveByWaId(tenantId: string, waId: string): Promise<string[]> {
    // `returning id` : l'appelant doit clore les sessions d'agent rattachées à ces parcours, sinon une session
    // reste `en_cours` avec un tour jamais commencé, invisible de la reprise des tours bloqués.
    const res = await this.pool.query<{ id: string }>(
      `update workflow_runs set status = 'done', current_node = null, resume_at = null, updated_at = now()
       where tenant_id = $1 and wa_id = $2 and status in ('waiting', 'sleeping')
       returning id`,
      [tenantId, waId],
    );
    return res.rows.map((r) => r.id);
  }

  /**
   * Réserve le tour d'avance d'un parcours, avant tout envoi : c'est ce qui ferme le double envoi, que
   * `setStateSiEncoreSur` (qui arrive après les envois) ne peut pas empêcher.
   *
   * Rend `null` quand un autre traitement tient déjà le tour : l'appelant sort alors sans rien faire (même
   * convention que `prendreLeTour` d'une session d'agent). Les trois pièces du verrou :
   * - le bail (`avance_jusqu_a`) : un worker tué ne bloque pas le parcours à vie ;
   * - le jeton, rendu à l'appelant, seul moyen de libérer : un porteur de bail périmé ne peut pas libérer le
   *   verrou de celui qui l'a repris ;
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
   * Prolonge le bail tant que l'avance travaille (cadence et raison : `bail-avance.ts`).
   *
   * Le jeton est la seule garde, sans condition sur `avance_jusqu_a` : un bail expiré que personne n'a repris
   * est encore le nôtre (un battement en retard), on peut le reprolonger. Si un autre l'a repris, le jeton a
   * changé, aucune ligne ne bouge, et `false` arrête le battement.
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
   * Rend le tour. Le jeton est dans le `where` : un porteur de bail périmé, revenu tard, ne peut pas libérer
   * le verrou de celui qui l'a repris. Best-effort chez l'appelant : un échec coûte au pire l'attente du bail.
   */
  async libererAvance(id: string, token: string): Promise<void> {
    await this.pool.query(
      `update workflow_runs set avance_token = null, avance_jusqu_a = null where id = $1 and avance_token = $2`,
      [id, token],
    );
  }

  /**
   * Écrit l'état d'un run seulement s'il attend encore sur le bloc qu'on croit, avec le jeton d'avance. Rend
   * `false` si rien n'a bougé.
   *
   * Un tour d'agent dure de 3 à 30 s et écrit son état à la fin ; entre-temps, tout démarrage de scénario
   * (`closeActiveByWaId`) peut avoir tué le run. Un `setState` inconditionnel le ressusciterait en `waiting`
   * avec une échéance, que `claimDueQuestions` réveillerait plus tard en parallèle du nouveau parcours. Le
   * jeton empêche en plus un porteur de bail périmé d'écrire par-dessus celui qui a repris le tour.
   *
   * `token` à `null` = l'appelant ne tient pas de réservation (l'échéance d'inactivité écrite par un tour d'agent,
   * `majRun` dans `src/worker.ts`) : la garde du jeton ne s'applique pas. L'avance d'un parcours, elle, réserve
   * toujours (`reserverAvance` est requise depuis la piste 8 du rapport d'architecture du 2026-10-02). Le
   * `is null` porte sur le paramètre, pas sur la colonne : un appelant qui tient un jeton est toujours confronté à
   * celui de la ligne.
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
   * Écrit l'état d'un run seulement s'il est encore vivant (`waiting` ou `sleeping`). Rend `false` s'il a été
   * clos entre-temps.
   *
   * La reprise d'un parcours endormi (`resume`) écrit à la fin, après des envois qui prennent du temps. Si
   * `closeActiveByWaId` est passé entre-temps (une fois par destinataire de campagne), un `setState`
   * réécrirait `waiting`/`sleeping` avec une échéance sur un run `done` : invisible de `findWaitingByWaId`,
   * mais réveillable par les balayages, il parlerait au client depuis un scénario abandonné. Pendant de
   * `setStateSiEncoreSur`, qui garde le bloc attendu ; ici la reprise change de bloc par construction.
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
    // `resume_at` sans coalesce : quitter le sommeil doit effacer l'échéance, sinon un run réveillé resterait
    // éligible au balayage suivant.
    await this.pool.query(
      // `channel` avec coalesce : un état écrit sans canal (clôture, remontée en inbox) ne doit pas ramener le
      // parcours sur WhatsApp par omission.
      `update workflow_runs set current_node = $2, status = $3, last_message_id = coalesce($4, last_message_id),
              resume_at = $5, channel = coalesce($6, channel), updated_at = now()
       where id = $1`,
      [id, state.currentNode, state.status, state.lastMessageId ?? null, state.resumeAt ?? null, state.channel ?? null],
    );
  }

  /**
   * Réclame les runs dormants dus (bail, voir `claimDue`) et rend les lignes prises, en une requête : un
   * `select` puis un `update` séparés réveilleraient le même parcours deux fois, donc enverraient en double.
   */
  async claimDueSleeping(limit: number): Promise<WorkflowRunRow[]> {
    return this.claimDue('sleeping', limit);
  }

  /**
   * Réclame les parcours qui attendent une réponse et dont le délai « pas de réponse » a expiré (bloc
   * Question).
   *
   * Même bail que `claimDueSleeping` : consommer l'échéance (`resume_at = null`) perdrait pour toujours une
   * reprise ratée (refus de Meta, worker redéployé), le parcours restant `waiting` sans échéance. Avec le bail,
   * une reprise interrompue redevient due 15 minutes plus tard ; c'est la reprise elle-même qui efface
   * l'échéance (toutes les sorties de `WorkflowExecutor.resume` passent par `setState`, sans coalesce).
   *
   * Le run reste `waiting`, donc une réponse du contact peut le reprendre à tout instant : on n'avale jamais
   * une réponse, et l'ordre inverse (réponse puis échéance) est sûr, `advance` effaçant `resume_at`.
   */
  async claimDueQuestions(limit: number): Promise<WorkflowRunRow[]> {
    return this.claimDue('waiting', limit);
  }

  /**
   * La réclamation commune aux deux balayages : un bail de 15 minutes sur les runs dus du statut donné, pris
   * d'un bloc et rendus en une requête.
   *
   * Bail, pas changement de statut. Passer un dormant à `waiting` le mettrait à portée de `advance` (un
   * message pendant la reprise rejouerait le même bloc et enverrait deux fois), et un worker tué laisserait un
   * run `waiting` figé que n'importe quel message ressusciterait. Avec le bail, un worker tué rend simplement
   * la ligne due à nouveau.
   *
   * Le bail doit couvrir la reprise de tout un lot (`batchSize`, 50) au pire cas, relances Meta comprises
   * (withRetry + Retry-After) : sinon la passe suivante re-réclame les derniers runs et deux reprises tournent
   * sur le même parcours.
   *
   * `created_at` borné à 90 jours : deux blocs Attente qui se pointent l'un l'autre se relanceraient pour
   * toujours (le sweeper clôt ces runs à part). Le statut est écrit en littéral, jamais en paramètre : un
   * paramètre priverait le planificateur des index partiels posés sur `status`.
   */
  private async claimDue(statut: 'sleeping' | 'waiting', limit: number): Promise<WorkflowRunRow[]> {
    const res = await this.pool.query<{
      id: string; workflow_id: string; tenant_id: string; wa_id: string; contact_id: string | null;
      current_node: string | null; last_message_id: string | null; channel: RunChannel | null;
      graphe_fige: WorkflowGraph | null;
    }>(
      `update workflow_runs r set resume_at = now() + interval '15 minutes', updated_at = now()
       from (
         select id from workflow_runs
         where status = '${statut}' and resume_at is not null and resume_at <= now()
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
      currentNode: r.current_node, status: statut, lastMessageId: r.last_message_id, channel: r.channel ?? 'whatsapp', grapheFige: parseGraph(r.graphe_fige),
    }));
  }

  /**
   * Clôt les parcours dormants trop vieux. `created_at` est l'âge du run, pas du sommeil : cela clôt surtout
   * un parcours abandonné, et accessoirement une chaîne d'attentes sans fin. Rend le nombre de parcours clos.
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
   * Purge les parcours terminés plus vieux que la rétention (ils portent le `wa_id`, donnée personnelle, et
   * plus rien ne les relit).
   *
   * 🔴 Un parcours vivant n'est jamais effacé, quel que soit son âge : le filtre porte sur les statuts
   * terminaux (`done`, `inbox`), comme l'index partiel de la migration 0097. Un run `waiting` ou `sleeping`
   * très vieux est une anomalie à corriger ailleurs, pas une ligne à supprimer sous les pieds d'un contact.
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
