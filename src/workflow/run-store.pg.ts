import type { Pool } from 'pg';

export interface WorkflowRunRow {
  id: string;
  workflowId: string;
  tenantId: string;
  waId: string;
  currentNode: string | null;
  status: 'waiting' | 'inbox' | 'done';
  lastMessageId: string | null;
}

export interface RunState {
  currentNode: string | null;
  status: 'waiting' | 'inbox' | 'done';
  lastMessageId?: string | null;
}

/** Suivi des runs (exécution par contact) d'un workflow. Le webhook avance UN run en attente par (tenant, wa_id). */
export class PgWorkflowRunStore {
  constructor(private readonly pool: Pool) {}

  async start(tenantId: string, workflowId: string, waId: string, contactId: string | null, state: RunState): Promise<{ id: string }> {
    const res = await this.pool.query<{ id: string }>(
      `insert into workflow_runs (workflow_id, tenant_id, contact_id, wa_id, current_node, status)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [workflowId, tenantId, contactId, waId, state.currentNode, state.status],
    );
    return { id: res.rows[0]!.id };
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

  async setState(id: string, state: RunState): Promise<void> {
    await this.pool.query(
      `update workflow_runs set current_node = $2, status = $3, last_message_id = coalesce($4, last_message_id), updated_at = now() where id = $1`,
      [id, state.currentNode, state.status, state.lastMessageId ?? null],
    );
  }
}
