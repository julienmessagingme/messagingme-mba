import type { Pool } from 'pg';
import { makeCode } from '../ids/code';
import { resolveTenantCode } from '../ids/tenant-code';

export interface TagCount {
  tag: string;
  count: number;
  /** Code public « tag_<client>_<ulid> » (schéma A). null pour un tag utilisé sur un contact mais jamais déclaré,
   *  ou tant que le backfill n'a pas tourné. */
  code?: string | null;
}

/**
 * Gestion des tags. Modèle mixte (lot 2) : une table `tags` de tags PRÉ-DÉCLARÉS (créés à vide) + les tags
 * portés par les contacts (`contacts.tags text[]`). Lister = UNION des deux avec le compte d'usage (0 si
 * déclaré mais non utilisé). Renommer/supprimer réconcilient les DEUX (table + arrays contacts). Scopé tenant.
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

  /** Union des tags déclarés (table) + utilisés (contacts), avec le compte d'usage (0 = déclaré, non utilisé).
   *  Le `code` public vient de la table des tags DÉCLARÉS (null pour un tag utilisé mais jamais déclaré). */
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
   * Renomme `from` -> `to` sur les contacts (re-dédup) ET dans la table des tags déclarés, en UNE
   * transaction (pas d'incohérence table/contacts si une requête échoue). Ne déclare `to` que si `from`
   * existait réellement (déclaré ou porté par un contact) -> pas de tag fantôme créé sur un `from` inconnu.
   * Renvoie le nb de contacts touchés.
   */
  async rename(tenantId: string, from: string, to: string): Promise<number> {
    // Code du tag cible calculé HORS transaction (lecture du code client sur le pool, indépendante du rename).
    const toCode = makeCode('tag', await resolveTenantCode(this.pool, tenantId));
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const res = await client.query(
        `update contacts
           set tags = (select coalesce(array_agg(distinct x), '{}') from unnest(array_replace(tags, $2, $3)) x)
           where tenant_id = $1 and tags @> array[$2]::text[]`,
        [tenantId, from, to],
      );
      const declared = await client.query('select 1 from tags where tenant_id = $1 and name = $2', [tenantId, from]);
      // `from` existait (utilisé sur un contact OU déclaré) -> on réconcilie la table (to peut déjà exister).
      if ((res.rowCount ?? 0) > 0 || (declared.rowCount ?? 0) > 0) {
        await client.query('insert into tags (tenant_id, name, code) values ($1, $2, $3) on conflict (tenant_id, name) do nothing', [tenantId, to, toCode]);
        await client.query('delete from tags where tenant_id = $1 and name = $2', [tenantId, from]);
      }
      await client.query('commit');
      return res.rowCount ?? 0;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Retire `tag` des contacts ET de la table des tags déclarés, en UNE transaction. Nb de contacts touchés. */
  async remove(tenantId: string, tag: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const res = await client.query(
        `update contacts set tags = array_remove(tags, $2) where tenant_id = $1 and tags @> array[$2]::text[]`,
        [tenantId, tag],
      );
      await client.query('delete from tags where tenant_id = $1 and name = $2', [tenantId, tag]);
      await client.query('commit');
      return res.rowCount ?? 0;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
