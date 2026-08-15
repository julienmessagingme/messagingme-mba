import type { Pool } from 'pg';

/** `sleeping` = le run attend que le TEMPS passe (bloc Attente), `waiting` qu'un CONTACT réponde. */
export type RunStatus = 'waiting' | 'inbox' | 'done' | 'sleeping';

export interface WorkflowRunRow {
  id: string;
  workflowId: string;
  tenantId: string;
  waId: string;
  contactId?: string | null;
  currentNode: string | null;
  status: RunStatus;
  lastMessageId: string | null;
}

export interface RunState {
  currentNode: string | null;
  status: RunStatus;
  lastMessageId?: string | null;
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
      `insert into workflow_runs (workflow_id, tenant_id, contact_id, wa_id, current_node, status, resume_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [workflowId, tenantId, contactId, waId, state.currentNode, state.status, state.resumeAt ?? null],
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
    }>(
      `select id, workflow_id, tenant_id, wa_id, current_node, status, last_message_id
       from workflow_runs where tenant_id = $1 and wa_id = $2 and status = 'waiting'
       order by created_at desc limit 1`,
      [tenantId, waId],
    );
    const r = res.rows[0];
    return r ? { id: r.id, workflowId: r.workflow_id, tenantId: r.tenant_id, waId: r.wa_id, currentNode: r.current_node, status: r.status, lastMessageId: r.last_message_id } : null;
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

  async setState(id: string, state: RunState): Promise<void> {
    // `resume_at` est écrit SANS coalesce : quitter le sommeil doit effacer l'échéance, sinon un run réveillé
    // resterait éligible au balayage suivant.
    await this.pool.query(
      `update workflow_runs set current_node = $2, status = $3, last_message_id = coalesce($4, last_message_id),
              resume_at = $5, updated_at = now()
       where id = $1`,
      [id, state.currentNode, state.status, state.lastMessageId ?? null, state.resumeAt ?? null],
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
      current_node: string | null; last_message_id: string | null;
    }>(
      // BAIL, pas changement de statut : on repousse l'échéance de 5 minutes en RESTANT `sleeping`.
      //  - passer à `waiting` mettrait le run à portée de `findWaitingByWaId`, donc de `advance` : un message
      //    du contact pendant la reprise rejouerait le MÊME bloc suivant et enverrait le message deux fois ;
      //  - et un worker tué après le claim laisserait un run `waiting` figé sur le bloc Attente, indiscernable
      //    d'un run sain, que n'importe quel message ultérieur ressusciterait (y compris après l'envoi).
      // Avec le bail : les autres workers ne voient plus la ligne comme due, `advance` ne la voit pas du tout,
      // et un worker tué la rend simplement due à nouveau 5 minutes plus tard.
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
       returning r.id, r.workflow_id, r.tenant_id, r.wa_id, r.contact_id, r.current_node, r.last_message_id`,
      [limit],
    );
    return res.rows.map((r) => ({
      id: r.id, workflowId: r.workflow_id, tenantId: r.tenant_id, waId: r.wa_id, contactId: r.contact_id,
      currentNode: r.current_node, status: 'sleeping' as const, lastMessageId: r.last_message_id,
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
