import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';
import { makeCode } from '../ids/code';
import { resolveTenantCode } from '../ids/tenant-code';

export interface TagCount {
  tag: string;
  count: number;
  /** Code public « tag_<client>_<ulid> ». null pour un tag porté par un contact mais jamais déclaré, ou non
   *  encore traité par le backfill. */
  code?: string | null;
}

/**
 * Gestion des tags, scopée tenant. Modèle mixte : une table `tags` de tags pré-déclarés, plus les tags portés
 * par les contacts (`contacts.tags text[]`). Lister = union des deux avec le compte d'usage ; renommer et
 * supprimer réconcilient les deux.
 */
export class PgTagStore {
  constructor(private readonly pool: Pool) {}

  /** Déclare un tag (réutilisable, même sans contact). Idempotent. true si créé, false s'il existait déjà. */
  async create(tenantId: string, name: string): Promise<boolean> {
    const code = makeCode('tag', await resolveTenantCode(this.pool, tenantId));
    const res = await this.pool.query(
      `insert into tags (tenant_id, name, code) values ($1, $2, $3) on conflict (tenant_id, name) do nothing`,
      [tenantId, name, code],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Union des tags déclarés et utilisés, avec le compte d'usage (0 = déclaré, non utilisé). Le `code` public
   *  vient de la table des tags déclarés. */
  async listDistinct(tenantId: string): Promise<TagCount[]> {
    const res = await this.pool.query<{ tag: string; count: string; code: string | null }>(
      `with declared as (select name as tag, code from tags where tenant_id = $1),
            used as (select t as tag, count(*)::int as cnt from contacts, unnest(tags) t where tenant_id = $1 group by t)
       select coalesce(d.tag, u.tag) as tag, coalesce(u.cnt, 0) as count, d.code
       from declared d full outer join used u on u.tag = d.tag
       order by 1`,
      [tenantId],
    );
    return res.rows.map((r) => ({ tag: r.tag, count: Number(r.count), code: r.code }));
  }

  /**
   * Renomme `from` -> `to` sur les contacts (dédupliqué) et dans la table des tags déclarés, en une transaction.
   * Ne déclare `to` que si `from` existait (déclaré ou porté), pour ne pas créer de tag fantôme. Rend le nombre
   * de contacts touchés.
   */
  async rename(tenantId: string, from: string, to: string): Promise<number> {
    // Code du tag cible calculé hors transaction (lecture sur le pool, indépendante du renommage).
    const toCode = makeCode('tag', await resolveTenantCode(this.pool, tenantId));
    return enTransaction(this.pool, async (client) => {
      const res = await client.query(
        `update contacts
           set tags = (select coalesce(array_agg(distinct x), '{}') from unnest(array_replace(tags, $2, $3)) x)
           where tenant_id = $1 and tags @> array[$2]::text[]`,
        [tenantId, from, to],
      );
      const declared = await client.query('select 1 from tags where tenant_id = $1 and name = $2', [tenantId, from]);
      // `from` existait (utilisé ou déclaré) -> on réconcilie la table (`to` peut déjà exister).
      if ((res.rowCount ?? 0) > 0 || (declared.rowCount ?? 0) > 0) {
        await client.query('insert into tags (tenant_id, name, code) values ($1, $2, $3) on conflict (tenant_id, name) do nothing', [tenantId, to, toCode]);
        await client.query('delete from tags where tenant_id = $1 and name = $2', [tenantId, from]);
      }
      return res.rowCount ?? 0;
    });
  }

  /** Retire `tag` des contacts et de la table des tags déclarés, en une transaction. Nb de contacts touchés. */
  async remove(tenantId: string, tag: string): Promise<number> {
    return enTransaction(this.pool, async (client) => {
      const res = await client.query(
        `update contacts set tags = array_remove(tags, $2) where tenant_id = $1 and tags @> array[$2]::text[]`,
        [tenantId, tag],
      );
      await client.query('delete from tags where tenant_id = $1 and name = $2', [tenantId, tag]);
      return res.rowCount ?? 0;
    });
  }
}
