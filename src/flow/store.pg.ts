import type { Pool } from 'pg';
import { fieldsOfScreens, screensOf } from '../meta/flow-json';
import type { FlowField, FlowFieldType, FlowScreenDef } from '../meta/flow-json';

export interface FlowRow {
  id: string;
  tenantId: string;
  name: string;
  status: 'DRAFT' | 'PUBLISHED';
  fields: FlowField[];
  /** Écrans du modèle riche, normalisés à la lecture (jsonb polymorphe : tableau plat = un écran, { screens } =
   *  plusieurs ; null pour les anciens flows simples). */
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
  /** Type Flow déclaré de chaque champ (clé -> type), pour canonicaliser la valeur avant écriture. */
  fieldTypes: Record<string, FlowFieldType>;
  /** Clés des champs de type `optin` (consentement) : leur passage à `true` ouvre le gate marketing. */
  optinFieldKeys: string[];
}

/** Forme brute d'une ligne `flows` telle que Postgres la rend. */
interface FlowDbRow {
  id: string; tenant_id: string; name: string; status: 'DRAFT' | 'PUBLISHED';
  fields: FlowField[]; elements: unknown; ref: string | null; mapping: Record<string, string> | null; cta: string | null;
  created_at: Date; updated_at: Date;
}

/** Ligne brute -> FlowRow, partagé par la liste et la lecture unitaire. */
function toFlowRow(r: FlowDbRow): FlowRow {
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
 * Suivi local des Flows (table `flows`), source de vérité pour l'UI : Meta ne renvoie pas leur structure. On stocke
 * `elements` (modèle riche), `ref` (discriminant au retour), `mapping`, et `fields` dérivé pour les consommateurs de
 * FlowRow.fields.
 */
export class PgFlowStore {
  constructor(private readonly pool: Pool) {}

  async insert(input: { id: string; tenantId: string; name: string; screens: FlowScreenDef[]; ref: string; mapping: Record<string, string>; cta?: string }): Promise<void> {
    // `elements` porte la forme { screens } ; les lignes anciennes restent en tableau plat, normalisées à la lecture.
    await this.pool.query(
      `insert into flows (id, tenant_id, name, fields, elements, ref, mapping, cta)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8)`,
      [input.id, input.tenantId, input.name, JSON.stringify(fieldsOfScreens(input.screens)), JSON.stringify({ screens: input.screens }), input.ref, JSON.stringify(input.mapping), input.cta ?? null],
    );
  }

  async list(tenantId: string): Promise<FlowRow[]> {
    const res = await this.pool.query<FlowDbRow>(
      `select id, tenant_id, name, status, fields, elements, ref, mapping, cta, created_at, updated_at from flows
       where tenant_id = $1 order by created_at desc`,
      [tenantId],
    );
    return res.rows.map(toFlowRow);
  }

  /** Un flow par id, filtré sur l'espace. null si absent ou d'un autre espace. */
  async getById(id: string, tenantId: string): Promise<FlowRow | null> {
    const res = await this.pool.query<FlowDbRow>(
      `select id, tenant_id, name, status, fields, elements, ref, mapping, cta, created_at, updated_at from flows
       where id = $1 and tenant_id = $2 limit 1`,
      [id, tenantId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return toFlowRow(r);
  }

  /**
   * Met à jour un flow DRAFT. `fields` est re-dérivé des écrans pour ne jamais diverger. `status='DRAFT'` dans le
   * WHERE : seconde barrière contre l'écriture d'un flow publié, immuable chez Meta.
   */
  async update(id: string, tenantId: string, patch: { name: string; screens: FlowScreenDef[]; ref: string; mapping: Record<string, string>; cta?: string }): Promise<boolean> {
    const res = await this.pool.query(
      `update flows set name = $3, fields = $4::jsonb, elements = $5::jsonb, ref = $6, mapping = $7::jsonb, cta = $8, updated_at = now()
       where id = $1 and tenant_id = $2 and status = 'DRAFT'`,
      [id, tenantId, patch.name, JSON.stringify(fieldsOfScreens(patch.screens)), JSON.stringify({ screens: patch.screens }), patch.ref, JSON.stringify(patch.mapping), patch.cta ?? null],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Insère un flow vu chez Meta mais absent de notre base (créé dans WhatsApp Manager). `elements`, `ref` et `mapping`
   * restent nuls, Meta ne renvoyant pas la structure : le formulaire est utilisable mais ses réponses n'alimentent
   * aucune fiche, faute de `ref`.
   * `on conflict do nothing` : l'id est une clé primaire globale, et deux espaces qui partagent un WABA voient le même
   * flow ; le second ne doit ni provoquer un 500 ni voler la ligne du premier.
   */
  async insertExternal(input: { id: string; tenantId: string; name: string; status: 'DRAFT' | 'PUBLISHED' }): Promise<boolean> {
    const res = await this.pool.query(
      `insert into flows (id, tenant_id, name, status) values ($1, $2, $3, $4) on conflict (id) do nothing`,
      [input.id, input.tenantId, input.name, input.status],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Aligne un flow local sur ce que Meta annonce (renommage, publication hors console). Le statut ne redescend jamais
   * de PUBLISHED à DRAFT, ce qui rouvrirait l'édition d'un flow immuable chez Meta. Le `where` ne retient que les
   * lignes qui changent, pour un compteur de réconciliation honnête.
   */
  async alignFromMeta(id: string, tenantId: string, patch: { name: string; status: 'DRAFT' | 'PUBLISHED' }): Promise<boolean> {
    const res = await this.pool.query(
      `update flows set name = $3, status = case when $4 = 'PUBLISHED' then 'PUBLISHED' else status end, updated_at = now()
       where id = $1 and tenant_id = $2
         and (name is distinct from $3 or ($4 = 'PUBLISHED' and status <> 'PUBLISHED'))`,
      [id, tenantId, patch.name, patch.status],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** L'espace, le mapping et les types de champ d'un flow par son `ref` (retour nfm_reply), null si inconnu. Les
   *  types servent à canonicaliser, et repèrent les champs OptIn (gate marketing). */
  async findByRef(ref: string): Promise<FlowMappingRow | null> {
    const res = await this.pool.query<{ tenant_id: string; mapping: Record<string, string> | null; fields: FlowField[] | null }>(
      `select tenant_id, mapping, fields from flows where ref = $1 limit 1`,
      [ref],
    );
    const r = res.rows[0];
    if (!r) return null;
    const fields = r.fields ?? [];
    return {
      tenantId: r.tenant_id,
      mapping: r.mapping ?? {},
      fieldTypes: Object.fromEntries(fields.map((f) => [f.key, f.type])),
      optinFieldKeys: fields.filter((f) => f.type === 'optin').map((f) => f.key),
    };
  }

  /** Le flow appartient-il à l'espace ? Garde-fou avant tout appel Meta de publication. */
  async belongsTo(flowId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(`select 1 from flows where id = $1 and tenant_id = $2`, [flowId, tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Les formulaires PUBLIÉS de l'espace, réduits à ce qu'un message interactif désigne (l'assistant de l'agent de Meta
   * les lit à chaque tour) : `list` ramènerait le contenu entier, images base64 comprises.
   */
  async listPublies(tenantId: string): Promise<Array<{ id: string; nom: string }>> {
    const res = await this.pool.query<{ id: string; name: string }>(
      `select id, name from flows where tenant_id = $1 and status = 'PUBLISHED' order by created_at desc`,
      [tenantId],
    );
    return res.rows.map((r) => ({ id: r.id, nom: r.name }));
  }

  /** Le flow est-il publié pour cet espace ? (vérification préalable de la route des templates) */
  async isPublished(flowId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(`select 1 from flows where id = $1 and tenant_id = $2 and status = 'PUBLISHED'`, [flowId, tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Passe le flow en PUBLISHED, filtré sur l'espace. true si une ligne a été mise à jour. */
  async markPublished(flowId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(
      `update flows set status = 'PUBLISHED', updated_at = now() where id = $1 and tenant_id = $2`,
      [flowId, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Retire le flow du store local (filtré sur l'espace), après suppression chez Meta. true si supprimé. */
  async remove(flowId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(`delete from flows where id = $1 and tenant_id = $2`, [flowId, tenantId]);
    return (res.rowCount ?? 0) > 0;
  }
}
