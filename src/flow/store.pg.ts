import type { Pool } from 'pg';
import { fieldsOfScreens, screensOf } from '../meta/flow-json';
import type { FlowField, FlowScreenDef } from '../meta/flow-json';

export interface FlowRow {
  id: string;
  tenantId: string;
  name: string;
  status: 'DRAFT' | 'PUBLISHED';
  fields: FlowField[];
  /** Écrans du modèle riche, NORMALISÉS à la lecture (colonne jsonb polymorphe : tableau plat historique
   *  = 1 écran, { screens } = multi ; null pour les vieux flows simples pré-phase-3). */
  screens: FlowScreenDef[] | null;
  ref: string | null;
  /** Mapping champ -> user field du contact (clé champ -> clé user field). */
  mapping: Record<string, string> | null;
  /** Libellé du bouton final (Footer du dernier écran). null = défaut « Envoyer ». */
  cta: string | null;
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

  async insert(input: { id: string; tenantId: string; name: string; screens: FlowScreenDef[]; ref: string; mapping: Record<string, string>; cta?: string }): Promise<void> {
    // La colonne `elements` (jsonb) porte désormais la forme { screens } ; les lignes historiques restent
    // en tableau plat (normalisées à la lecture par screensOf, AUCUNE migration).
    await this.pool.query(
      `insert into flows (id, tenant_id, name, fields, elements, ref, mapping, cta)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8)`,
      [input.id, input.tenantId, input.name, JSON.stringify(fieldsOfScreens(input.screens)), JSON.stringify({ screens: input.screens }), input.ref, JSON.stringify(input.mapping), input.cta ?? null],
    );
  }

  async list(tenantId: string): Promise<FlowRow[]> {
    const res = await this.pool.query<{
      id: string; tenant_id: string; name: string; status: 'DRAFT' | 'PUBLISHED';
      fields: FlowField[]; elements: unknown; ref: string | null; mapping: Record<string, string> | null; cta: string | null;
      created_at: Date; updated_at: Date;
    }>(
      `select id, tenant_id, name, status, fields, elements, ref, mapping, cta, created_at, updated_at from flows
       where tenant_id = $1 order by created_at desc`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      status: r.status,
      fields: r.fields,
      screens: screensOf(r.elements),
      ref: r.ref,
      mapping: r.mapping,
      cta: r.cta,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  /** Un flow par id, scopé tenant (pour l'édition : lire le status/screens). null si absent/autre tenant. */
  async getById(id: string, tenantId: string): Promise<FlowRow | null> {
    const res = await this.pool.query<{
      id: string; tenant_id: string; name: string; status: 'DRAFT' | 'PUBLISHED';
      fields: FlowField[]; elements: unknown; ref: string | null; mapping: Record<string, string> | null; cta: string | null;
      created_at: Date; updated_at: Date;
    }>(
      `select id, tenant_id, name, status, fields, elements, ref, mapping, cta, created_at, updated_at from flows
       where id = $1 and tenant_id = $2 limit 1`,
      [id, tenantId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      status: r.status,
      fields: r.fields,
      screens: screensOf(r.elements),
      ref: r.ref,
      mapping: r.mapping,
      cta: r.cta,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }

  /**
   * Met à jour un flow DRAFT (name/screens/ref/mapping). `fields` est RE-DÉRIVÉ (fieldsOfScreens) pour ne
   * jamais diverger des écrans. WHERE status='DRAFT' : 2e barrière SQL contre l'écriture d'un PUBLISHED
   * (immuable chez Meta). Renvoie true si une ligne DRAFT du tenant a été mise à jour.
   */
  async update(id: string, tenantId: string, patch: { name: string; screens: FlowScreenDef[]; ref: string; mapping: Record<string, string>; cta?: string }): Promise<boolean> {
    const res = await this.pool.query(
      `update flows set name = $3, fields = $4::jsonb, elements = $5::jsonb, ref = $6, mapping = $7::jsonb, cta = $8, updated_at = now()
       where id = $1 and tenant_id = $2 and status = 'DRAFT'`,
      [id, tenantId, patch.name, JSON.stringify(fieldsOfScreens(patch.screens)), JSON.stringify({ screens: patch.screens }), patch.ref, JSON.stringify(patch.mapping), patch.cta ?? null],
    );
    return (res.rowCount ?? 0) > 0;
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

  /** Retire le flow du store local (scopé tenant), après suppression/dépréciation côté Meta. true si supprimé. */
  async remove(flowId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(`delete from flows where id = $1 and tenant_id = $2`, [flowId, tenantId]);
    return (res.rowCount ?? 0) > 0;
  }
}
