import type { Pool } from 'pg';
import type { ParamSource } from './template';

/** Un indice « variable {{position}} -> champ » d'un template (posé au design, relu à la campagne). */
export interface ParamHint {
  position: number;
  source: ParamSource;
}

/**
 * Store Postgres des indices de mapping variable -> champ d'un template (table `template_param_hints`).
 * `save` REMPLACE tous les indices d'un (template, langue) en une transaction (le corps a pu changer).
 */
export class PgTemplateHintStore {
  constructor(private readonly pool: Pool) {}

  async save(tenantId: string, name: string, language: string, hints: ParamHint[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        'delete from template_param_hints where tenant_id = $1 and template_name = $2 and template_language = $3',
        [tenantId, name, language],
      );
      for (const h of hints) {
        await client.query(
          `insert into template_param_hints (tenant_id, template_name, template_language, position, source)
           values ($1, $2, $3, $4, $5::jsonb)`,
          [tenantId, name, language, h.position, JSON.stringify(h.source)],
        );
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async get(tenantId: string, name: string, language: string): Promise<ParamHint[]> {
    const res = await this.pool.query<{ position: number; source: ParamSource }>(
      `select position, source from template_param_hints
       where tenant_id = $1 and template_name = $2 and template_language = $3 order by position`,
      [tenantId, name, language],
    );
    return res.rows.map((r) => ({ position: r.position, source: r.source }));
  }

  /** Retire les indices d'un template (toutes langues) — appelé à la suppression du template. */
  async removeByName(tenantId: string, name: string): Promise<void> {
    await this.pool.query('delete from template_param_hints where tenant_id = $1 and template_name = $2', [tenantId, name]);
  }
}
