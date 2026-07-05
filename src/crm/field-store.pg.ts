import type { Pool } from 'pg';
import type { UserFieldStore } from './fields';
import type { UserFieldDef, UserFieldType } from './types';

/** Store Postgres des champs perso (user fields) par tenant. */
export class PgUserFieldStore implements UserFieldStore {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string): Promise<UserFieldDef[]> {
    const res = await this.pool.query<{ key: string; label: string; type: UserFieldType }>(
      `select key, label, type from user_fields where tenant_id = $1 order by key`,
      [tenantId],
    );
    return res.rows.map((r) => ({ key: r.key, label: r.label, type: r.type }));
  }

  async upsert(tenantId: string, def: UserFieldDef): Promise<void> {
    await this.pool.query(
      `insert into user_fields (tenant_id, key, label, type) values ($1, $2, $3, $4)
       on conflict (tenant_id, key) do nothing`,
      [tenantId, def.key, def.label, def.type],
    );
  }
}
