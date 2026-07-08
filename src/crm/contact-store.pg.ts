import type { Pool } from 'pg';
import type { ContactStore, ContactUpsert } from './import';

export interface ContactRow {
  id: string;
  phoneE164: string | null;
  profileName: string | null;
  optInStatus: string;
  fields: Record<string, unknown>;
  tags: string[];
  createdAt: string;
}

/**
 * Store Postgres des contacts. Upsert par (tenant, téléphone) avec MERGE jsonb des
 * champs perso (jamais d'écrasement des clés absentes du CSV courant) et opt-in qui
 * ne régresse jamais (unknown -> opted_in seulement).
 */
export class PgContactStore implements ContactStore {
  constructor(private readonly pool: Pool) {}

  async upsertByPhone(c: ContactUpsert): Promise<'created' | 'updated'> {
    // Index unique PARTIEL contacts_tenant_phone_uidx (where phone_e164 is not null) :
    // le ON CONFLICT doit répéter le prédicat pour cibler cet index.
    const res = await this.pool.query<{ created: boolean }>(
      `insert into contacts (tenant_id, phone_e164, profile_name, fields, opt_in_status, opt_in_source, tags)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7::text[])
       on conflict (tenant_id, phone_e164) where phone_e164 is not null
       do update set
         fields = contacts.fields || excluded.fields,
         profile_name = coalesce(excluded.profile_name, contacts.profile_name),
         opt_in_status = case
           when excluded.opt_in_status = 'opted_in' then 'opted_in'
           else contacts.opt_in_status
         end,
         opt_in_source = coalesce(excluded.opt_in_source, contacts.opt_in_source),
         -- Union dédupliquée : les nouveaux tags s'ajoutent, jamais d'écrasement.
         tags = (select coalesce(array_agg(distinct t), '{}') from unnest(contacts.tags || excluded.tags) t),
         updated_at = now()
       returning (xmax = 0) as created`,
      [
        c.tenantId,
        c.phoneE164,
        c.profileName,
        JSON.stringify(c.fields),
        c.optInStatus,
        c.optInSource ?? null,
        c.tags ?? [],
      ],
    );
    return res.rows[0]?.created ? 'created' : 'updated';
  }

  /** Liste paginée des contacts d'un tenant (les plus récents d'abord). */
  async list(tenantId: string, limit = 100, offset = 0): Promise<ContactRow[]> {
    const capped = Math.min(Math.max(limit, 1), 500);
    const res = await this.pool.query<{
      id: string;
      phone_e164: string | null;
      profile_name: string | null;
      opt_in_status: string;
      fields: Record<string, unknown>;
      tags: string[] | null;
      created_at: Date;
    }>(
      `select id, phone_e164, profile_name, opt_in_status, fields, tags, created_at
       from contacts where tenant_id = $1
       order by created_at desc
       limit $2 offset $3`,
      [tenantId, capped, Math.max(offset, 0)],
    );
    return res.rows.map((r) => ({
      id: r.id,
      phoneE164: r.phone_e164,
      profileName: r.profile_name,
      optInStatus: r.opt_in_status,
      fields: r.fields,
      tags: r.tags ?? [],
      createdAt: r.created_at.toISOString(),
    }));
  }
}
