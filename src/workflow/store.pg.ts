import type { Pool } from 'pg';
import type { WorkflowGraph } from './graph';

export interface WorkflowRow {
  id: string;
  tenantId: string;
  name: string;
  graph: WorkflowGraph;
  createdAt: string;
  updatedAt: string;
}

const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [] };

/** Store Postgres des workflows (bot builder). Scopé tenant. `graph` = jsonb du graphe de blocs. */
export class PgWorkflowStore {
  constructor(private readonly pool: Pool) {}

  async insert(tenantId: string, name: string, graph: WorkflowGraph): Promise<{ id: string }> {
    const res = await this.pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, graph) values ($1, $2, $3::jsonb) returning id`,
      [tenantId, name, JSON.stringify(graph)],
    );
    return { id: res.rows[0]!.id };
  }

  async list(tenantId: string): Promise<WorkflowRow[]> {
    const res = await this.pool.query<Row>(
      `select id, tenant_id, name, graph, created_at, updated_at from workflows
       where tenant_id = $1 order by created_at desc`,
      [tenantId],
    );
    return res.rows.map(toRow);
  }

  async getById(id: string, tenantId: string): Promise<WorkflowRow | null> {
    const res = await this.pool.query<Row>(
      `select id, tenant_id, name, graph, created_at, updated_at from workflows
       where id = $1 and tenant_id = $2 limit 1`,
      [id, tenantId],
    );
    const r = res.rows[0];
    return r ? toRow(r) : null;
  }

  /** MAJ partielle (name/graph). true si une ligne du tenant a bougé. `coalesce` : un champ absent
   *  ne l'écrase pas. Le graphe passé est DÉJÀ validé/sanitisé par la route (parseGraph). */
  async update(id: string, tenantId: string, patch: { name?: string; graph?: WorkflowGraph }): Promise<boolean> {
    const res = await this.pool.query(
      `update workflows set
         name = coalesce($3, name),
         graph = coalesce($4::jsonb, graph),
         updated_at = now()
       where id = $1 and tenant_id = $2`,
      [id, tenantId, patch.name ?? null, patch.graph ? JSON.stringify(patch.graph) : null],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async remove(id: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(`delete from workflows where id = $1 and tenant_id = $2`, [id, tenantId]);
    return (res.rowCount ?? 0) > 0;
  }
}

interface Row {
  id: string; tenant_id: string; name: string;
  graph: WorkflowGraph | null; created_at: Date; updated_at: Date;
}
function toRow(r: Row): WorkflowRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    graph: r.graph ?? EMPTY_GRAPH,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}
