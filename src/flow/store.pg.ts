import type { Pool } from 'pg';
import type { FlowField } from '../meta/flow-json';

export interface FlowRow {
  id: string;
  tenantId: string;
  name: string;
  status: 'DRAFT' | 'PUBLISHED';
  fields: FlowField[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Suivi local des Flows (table `flows`). Source de vérité pour l'UI (Meta ne renvoie pas la structure
 * des champs). Tout est scopé au tenant. Le statut n'est mis à jour que par notre propre publish.
 */
export class PgFlowStore {
  constructor(private readonly pool: Pool) {}

  async insert(input: { id: string; tenantId: string; name: string; fields: FlowField[] }): Promise<void> {
    await this.pool.query(
      `insert into flows (id, tenant_id, name, fields) values ($1, $2, $3, $4::jsonb)`,
      [input.id, input.tenantId, input.name, JSON.stringify(input.fields)],
    );
  }

  async list(tenantId: string): Promise<FlowRow[]> {
    const res = await this.pool.query<{ id: string; tenant_id: string; name: string; status: 'DRAFT' | 'PUBLISHED'; fields: FlowField[]; created_at: Date; updated_at: Date }>(
      `select id, tenant_id, name, status, fields, created_at, updated_at from flows
       where tenant_id = $1 order by created_at desc`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      status: r.status,
      fields: r.fields,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  /** Le flow appartient-il au tenant ? (garde-fou AVANT tout appel Meta sur publish.) */
  async belongsTo(flowId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(`select 1 from flows where id = $1 and tenant_id = $2`, [flowId, tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Le flow est-il PUBLISHED pour ce tenant ? (pré-check côté route templates.) */
  async isPublished(flowId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(`select 1 from flows where id = $1 and tenant_id = $2 and status = 'PUBLISHED'`, [flowId, tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Passe le flow en PUBLISHED (scopé tenant). true si une ligne a été mise à jour. */
  async markPublished(flowId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(
      `update flows set status = 'PUBLISHED', updated_at = now() where id = $1 and tenant_id = $2`,
      [flowId, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
