import type { Pool } from 'pg';
import type { WorkflowGraph } from './graph';
import { makeCode } from '../ids/code';
import { resolveTenantCode } from '../ids/tenant-code';

export interface WorkflowRow {
  id: string;
  tenantId: string;
  name: string;
  /** Code public « scn_<client>_<ulid> » (schéma A). null tant que le backfill n'a pas tourné (lignes anciennes). */
  code?: string | null;
  graph: WorkflowGraph;
  createdAt: string;
  updatedAt: string;
}

const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [] };

/** Store Postgres des workflows (bot builder). Scopé tenant. `graph` = jsonb du graphe de blocs. */
export class PgWorkflowStore {
  constructor(private readonly pool: Pool) {}

  async insert(tenantId: string, name: string, graph: WorkflowGraph): Promise<{ id: string }> {
    const code = makeCode('scn', await resolveTenantCode(this.pool, tenantId));
    const res = await this.pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, graph, code) values ($1, $2, $3::jsonb, $4) returning id`,
      [tenantId, name, JSON.stringify(graph), code],
    );
    return { id: res.rows[0]!.id };
  }

  async list(tenantId: string): Promise<WorkflowRow[]> {
    const res = await this.pool.query<Row>(
      `select id, tenant_id, name, code, graph, created_at, updated_at from workflows
       where tenant_id = $1 order by created_at desc`,
      [tenantId],
    );
    return res.rows.map(toRow);
  }

  async getById(id: string, tenantId: string): Promise<WorkflowRow | null> {
    const res = await this.pool.query<Row>(
      `select id, tenant_id, name, code, graph, created_at, updated_at from workflows
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

  /**
   * Jeton de test du scénario, créé À LA DEMANDE et STABLE ensuite : le lien wa.me et son QR restent valables,
   * on ne les régénère pas à chaque essai. Renvoie le jeton existant s'il y en a déjà un (idempotent), sinon
   * en pose un neuf. null si le scénario n'appartient pas au tenant.
   *
   * `coalesce` dans l'UPDATE + `returning` : un seul aller-retour, et deux clics simultanés sur « Tester » ne
   * peuvent pas produire deux jetons (le second lit celui que le premier vient d'écrire).
   */
  async ensureTestToken(id: string, tenantId: string, token: string): Promise<string | null> {
    const res = await this.pool.query<{ test_token: string }>(
      `update workflows set test_token = coalesce(test_token, $3), updated_at = updated_at
       where id = $1 and tenant_id = $2 returning test_token`,
      [id, tenantId, token],
    );
    return res.rows[0]?.test_token ?? null;
  }

  /**
   * Scénario associé à un jeton de test. CHEMIN CHAUD (un message entrant qui ressemble à un jeton) : sert
   * l'index unique partiel `workflows_test_token_key`. Pas de scope tenant en entrée, justement parce que le
   * jeton est ce qui DÉSIGNE le tenant : c'est l'appelant qui vérifie ensuite que le numéro correspond.
   */
  async findByTestToken(token: string): Promise<WorkflowRow | null> {
    const res = await this.pool.query<Row>(
      `select id, tenant_id, name, code, graph, created_at, updated_at from workflows
       where test_token = $1 limit 1`,
      [token],
    );
    const r = res.rows[0];
    return r ? toRow(r) : null;
  }
}

interface Row {
  id: string; tenant_id: string; name: string; code: string | null;
  graph: WorkflowGraph | null; created_at: Date; updated_at: Date;
}
function toRow(r: Row): WorkflowRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    code: r.code,
    graph: r.graph ?? EMPTY_GRAPH,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}
