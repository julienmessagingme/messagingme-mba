import type { Pool } from 'pg';

export interface TagCount {
  tag: string;
  count: number;
}

/**
 * Gestion des tags. Les tags sont DÉRIVÉS des contacts (`contacts.tags text[]`, pas de table dédiée) :
 * lister = agréger, renommer/supprimer = éditer les arrays. Tout est scopé au tenant. Renommer re-dédup
 * (si la cible existe déjà sur un contact, pas de doublon).
 */
export class PgTagStore {
  constructor(private readonly pool: Pool) {}

  async listDistinct(tenantId: string): Promise<TagCount[]> {
    const res = await this.pool.query<{ tag: string; count: string }>(
      `select t as tag, count(*)::int as count
       from contacts, unnest(tags) t
       where tenant_id = $1
       group by t order by t`,
      [tenantId],
    );
    return res.rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
  }

  /** Renomme `from` -> `to` sur tous les contacts du tenant, en re-dédupliquant. Nb de contacts touchés. */
  async rename(tenantId: string, from: string, to: string): Promise<number> {
    const res = await this.pool.query(
      `update contacts
         set tags = (select coalesce(array_agg(distinct x), '{}') from unnest(array_replace(tags, $2, $3)) x)
         where tenant_id = $1 and tags @> array[$2]::text[]`,
      [tenantId, from, to],
    );
    return res.rowCount ?? 0;
  }

  /** Retire `tag` de tous les contacts du tenant. Nb de contacts touchés. */
  async remove(tenantId: string, tag: string): Promise<number> {
    const res = await this.pool.query(
      `update contacts set tags = array_remove(tags, $2) where tenant_id = $1 and tags @> array[$2]::text[]`,
      [tenantId, tag],
    );
    return res.rowCount ?? 0;
  }
}
