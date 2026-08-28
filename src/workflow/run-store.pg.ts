import type { Pool } from 'pg';

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

  async start(tenantId: string, workflowId: string, waId: string, contactId: string | null, state: RunState): Promise<{ id: string }> {
    // `resume_at` est écrit DÈS LA CRÉATION : un scénario dont le tout premier passage tombe sur un bloc
    // Attente naît directement en sommeil. L'omettre laissait un run `sleeping` SANS échéance, que le balayage
    // (qui exige `resume_at <= now()`) n'aurait jamais réveillé : parcours mort en silence.
    const res = await this.pool.query<{ id: string }>(
      `insert into workflow_runs (workflow_id, tenant_id, contact_id, wa_id, current_node, status, resume_at, channel)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [workflowId, tenantId, contactId, waId, state.currentNode, state.status, state.resumeAt ?? null, state.channel ?? 'whatsapp'],
    );
    return { id: res.rows[0]!.id };
  }

  /**
   * Un run est-il en attente pour ce contact ET assez RÉCENT pour qu'on le considère encore vivant ?
   *
   * Un run `waiting` n'expire jamais tout seul : seul le contact peut le faire avancer en répondant. Sans borne
   * d'âge, un contact qui ne répond pas resterait « occupé » à vie, et aucune automation ne pourrait plus jamais
   * le toucher, en silence. On considère donc qu'au-delà de `maxAgeMs` le parcours est abandonné.
   */
  async hasRecentWaitingRun(tenantId: string, waId: string, maxAgeMs: number): Promise<boolean> {
    // Un parcours ENDORMI occupe le contact autant qu'un parcours en attente : il reprendra tout seul et
    // écrira au client. L'omettre laissait une automation démarrer un SECOND parcours pendant une attente,
    // et les deux envoyaient au réveil. Pas de borne d'âge sur le sommeil : son échéance EST sa borne.
    const res = await this.pool.query<{ n: string }>(
      `select count(*)::int as n from workflow_runs
       where tenant_id = $1 and wa_id = $2
         and ( (status = 'waiting' and updated_at >= now() - make_interval(secs => $3 / 1000.0))
            or (status = 'sleeping' and resume_at is not null) )`,
      [tenantId, waId, maxAgeMs],
    );
    return Number(res.rows[0]?.n ?? 0) > 0;
  }

  /** LE run en attente d'un contact (par tenant + numéro). Un seul actif à la fois par contact (V1). */
  async findWaitingByWaId(tenantId: string, waId: string): Promise<WorkflowRunRow | null> {
    const res = await this.pool.query<{
      id: string; workflow_id: string; tenant_id: string; wa_id: string;
      current_node: string | null; status: 'waiting' | 'inbox' | 'done'; last_message_id: string | null;
      channel: RunChannel | null;
    }>(
      `select id, workflow_id, tenant_id, wa_id, current_node, status, last_message_id, channel
       from workflow_runs where tenant_id = $1 and wa_id = $2 and status = 'waiting'
       order by created_at desc limit 1`,
      [tenantId, waId],
    );
    const r = res.rows[0];
    return r ? {
      id: r.id, workflowId: r.workflow_id, tenantId: r.tenant_id, waId: r.wa_id,
      currentNode: r.current_node, status: r.status, lastMessageId: r.last_message_id,
      channel: r.channel ?? 'whatsapp',
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
      channel: RunChannel | null;
    }>(
      `select id, workflow_id, tenant_id, wa_id, current_node, status, last_message_id, channel
       from workflow_runs where tenant_id = $1 and id = $2`,
      [tenantId, id],
    );
    const r = res.rows[0];
    return r ? {
      id: r.id, workflowId: r.workflow_id, tenantId: r.tenant_id, waId: r.wa_id,
      currentNode: r.current_node, status: r.status, lastMessageId: r.last_message_id,
      channel: r.channel ?? 'whatsapp',
    } : null;
  }

  /**
   * Clôt TOUS les parcours encore actifs d'un contact (en attente d'une réponse, ou endormis sur un bloc
   * Attente) et rend combien ont été clos.
   *
   * Sert au lancement MANUEL d'un scénario depuis l'Inbox. Sans ça, un opérateur qui en lance un second crée
   * deux runs concurrents : `findWaitingByWaId` ne rend que le plus récent (`limit 1`), donc le premier
   * devient orphelin POUR TOUJOURS (aucun balayage ne nettoie un run `waiting`), invisible, pendant que le
   * contact reçoit les messages des deux. On tranche dans le sens de l'opérateur : c'est lui qui décide, son
   * nouveau scénario remplace l'ancien. Même parti pris que le lien de test d'un scénario.
   */
  async closeActiveByWaId(tenantId: string, waId: string): Promise<number> {
    const res = await this.pool.query(
      `update workflow_runs set status = 'done', current_node = null, resume_at = null, updated_at = now()
       where tenant_id = $1 and wa_id = $2 and status in ('waiting', 'sleeping')`,
      [tenantId, waId],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Écrit l'état d'un run SEULEMENT s'il attend encore sur le bloc qu'on croit. Rend `false` si rien n'a bougé.
   *
   * 🔴 POURQUOI CETTE VARIANTE EXISTE. Un tour d'agent dure 3 à 30 secondes, et il écrit son état à la fin.
   * Entre-temps, le run peut avoir été TUÉ : un opérateur qui lance un scénario depuis l'Inbox appelle
   * `closeActiveByWaId`, qui passe le run en `done` et en crée un autre. Un `setState` inconditionnel le
   * ressusciterait en `waiting` AVEC une échéance : invisible de `findWaitingByWaId` (le nouveau run est plus
   * récent), mais parfaitement visible de `claimDueQuestions`, qui déclencherait plus tard la branche
   * « pas de réponse » d'un parcours que quelqu'un avait délibérément fermé, en parallèle du nouveau.
   *
   * C'est le pendant, côté ÉCRITURE, de la garde que le tour applique déjà en lecture : « le run attend-il
   * toujours sur CE bloc ». Même motif de verrou optimiste que `prendreLeTour` et `claimDueQuestions`.
   */
  async setStateSiEncoreSur(tenantId: string, id: string, nodeId: string, state: RunState): Promise<boolean> {
    const res = await this.pool.query(
      `update workflow_runs set current_node = $4, status = $5,
              last_message_id = coalesce($6, last_message_id), resume_at = $7,
              channel = coalesce($8, channel), updated_at = now()
        where id = $1 and tenant_id = $2 and status = 'waiting' and current_node = $3`,
      [id, tenantId, nodeId, state.currentNode, state.status, state.lastMessageId ?? null, state.resumeAt ?? null, state.channel ?? null],
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
       returning r.id, r.workflow_id, r.tenant_id, r.wa_id, r.contact_id, r.current_node, r.last_message_id, r.channel`,
      [limit],
    );
    return res.rows.map((r) => ({
      id: r.id, workflowId: r.workflow_id, tenantId: r.tenant_id, waId: r.wa_id, contactId: r.contact_id,
      currentNode: r.current_node, status: 'sleeping' as const, lastMessageId: r.last_message_id, channel: r.channel ?? 'whatsapp',
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
       returning r.id, r.workflow_id, r.tenant_id, r.wa_id, r.contact_id, r.current_node, r.last_message_id, r.channel`,
      [limit],
    );
    return res.rows.map((r) => ({
      id: r.id, workflowId: r.workflow_id, tenantId: r.tenant_id, waId: r.wa_id, contactId: r.contact_id,
      currentNode: r.current_node, status: 'waiting' as const, lastMessageId: r.last_message_id, channel: r.channel ?? 'whatsapp',
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
}
