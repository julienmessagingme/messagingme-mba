import type { Pool } from 'pg';
import { fieldsOf } from '../meta/flow-json';
import type { FlowField, FlowElement } from '../meta/flow-json';

export interface FlowRow {
  id: string;
  tenantId: string;
  name: string;
  status: 'DRAFT' | 'PUBLISHED';
  fields: FlowField[];
  /** Éléments riches (null pour les vieux flows simples pré-phase-3). */
  elements: FlowElement[] | null;
  ref: string | null;
  /** Mapping champ -> user field du contact (clé champ -> clé user field). */
  mapping: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
}

/** Ce dont le webhook a besoin pour poser les valeurs d'un flow rempli sur le contact. */
export interface FlowMappingRow {
  tenantId: string;
  mapping: Record<string, string>;
}

/**
 * Suivi local des Flows (table `flows`). Source de vérité pour l'UI (Meta ne renvoie pas la structure).
 * On stocke `elements` (modèle riche) + `ref` (discriminant au retour) + `mapping` (champ -> user field),
 * ET `fields` DÉRIVÉ (fieldsOf) pour ne pas casser les consommateurs de FlowRow.fields.
 */
export class PgFlowStore {
  constructor(private readonly pool: Pool) {}

  async insert(input: { id: string; tenantId: string; name: string; elements: FlowElement[]; ref: string; mapping: Record<string, string> }): Promise<void> {
    await this.pool.query(
      `insert into flows (id, tenant_id, name, fields, elements, ref, mapping)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb)`,
      [input.id, input.tenantId, input.name, JSON.stringify(fieldsOf(input.elements)), JSON.stringify(input.elements), input.ref, JSON.stringify(input.mapping)],
    );
  }

  async list(tenantId: string): Promise<FlowRow[]> {
    const res = await this.pool.query<{
      id: string; tenant_id: string; name: string; status: 'DRAFT' | 'PUBLISHED';
      fields: FlowField[]; elements: FlowElement[] | null; ref: string | null; mapping: Record<string, string> | null;
      created_at: Date; updated_at: Date;
    }>(
      `select id, tenant_id, name, status, fields, elements, ref, mapping, created_at, updated_at from flows
       where tenant_id = $1 order by created_at desc`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      status: r.status,
      fields: r.fields,
      elements: r.elements,
      ref: r.ref,
      mapping: r.mapping,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  /** Retrouve le tenant + le mapping d'un flow par son `ref` (retour nfm_reply). null si inconnu. */
  async findByRef(ref: string): Promise<FlowMappingRow | null> {
    const res = await this.pool.query<{ tenant_id: string; mapping: Record<string, string> | null }>(
      `select tenant_id, mapping from flows where ref = $1 limit 1`,
      [ref],
    );
    const r = res.rows[0];
    return r ? { tenantId: r.tenant_id, mapping: r.mapping ?? {} } : null;
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
