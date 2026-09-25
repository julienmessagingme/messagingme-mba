import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';
import type { ParamSource } from './template';

/** Un indice « variable {{position}} -> champ » d'un template (posé au design, relu à la campagne). */
export interface ParamHint {
  position: number;
  source: ParamSource;
}

/** Un indice de l'espace, avec le template qui le porte : ce que le catalogue de l'API publique lit en UNE fois. */
export interface IndiceDuTemplate extends ParamHint {
  name: string;
  language: string;
}

/**
 * Store Postgres des indices de mapping variable -> champ d'un template (table `template_param_hints`).
 * `save` REMPLACE tous les indices d'un (template, langue) en une transaction (le corps a pu changer).
 */
export class PgTemplateHintStore {
  constructor(private readonly pool: Pool) {}

  async save(tenantId: string, name: string, language: string, hints: ParamHint[]): Promise<void> {
    await enTransaction(this.pool, async (client) => {
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
    });
  }

  async get(tenantId: string, name: string, language: string): Promise<ParamHint[]> {
    const res = await this.pool.query<{ position: number; source: ParamSource }>(
      `select position, source from template_param_hints
       where tenant_id = $1 and template_name = $2 and template_language = $3 order by position`,
      [tenantId, name, language],
    );
    return res.rows.map((r) => ({ position: r.position, source: r.source }));
  }

  /**
   * TOUS les indices de l'espace, en UNE requête, pour `GET /v1/templates`.
   *
   * ⚠️ UNE requête et pas une par template : le catalogue liste tous les templates approuvés du WABA, et
   * `get` appelé en boucle ferait autant d'allers-retours. La clé primaire commence par `tenant_id`, elle
   * sert donc ce filtre. La source sort telle que stockée : c'est la ROUTE qui la revalide avant de la
   * rendre à un tiers.
   */
  async listerParEspace(tenantId: string): Promise<IndiceDuTemplate[]> {
    const res = await this.pool.query<{ template_name: string; template_language: string; position: number; source: ParamSource }>(
      `select template_name, template_language, position, source from template_param_hints
       where tenant_id = $1 order by template_name, template_language, position`,
      [tenantId],
    );
    return res.rows.map((r) => ({ name: r.template_name, language: r.template_language, position: r.position, source: r.source }));
  }

  /** Retire les indices d'un template (toutes langues) — appelé à la suppression du template. */
  async removeByName(tenantId: string, name: string): Promise<void> {
    await this.pool.query('delete from template_param_hints where tenant_id = $1 and template_name = $2', [tenantId, name]);
  }
}
