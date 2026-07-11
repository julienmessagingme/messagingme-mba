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

  /**
   * Met à jour le libellé et/ou le type d'un champ. La CLÉ est immuable (la renommer casserait les
   * paramMapping de campagnes + les valeurs `contacts.fields` indexées par clé). true si une ligne a bougé.
   */
  async updateField(tenantId: string, key: string, patch: { label?: string; type?: UserFieldType }): Promise<boolean> {
    const sets: string[] = [];
    const vals: unknown[] = [tenantId, key];
    if (patch.label !== undefined) {
      vals.push(patch.label);
      sets.push(`label = $${vals.length}`);
    }
    if (patch.type !== undefined) {
      vals.push(patch.type);
      sets.push(`type = $${vals.length}`);
    }
    if (sets.length === 0) return false;
    const res = await this.pool.query(`update user_fields set ${sets.join(', ')} where tenant_id = $1 and key = $2`, vals);
    return (res.rowCount ?? 0) > 0;
  }

  /** Supprime la DÉFINITION du champ. NE purge PAS les valeurs déjà stockées dans `contacts.fields`
   *  (orphelines mais inoffensives, réversibles en recréant la clé). true si la définition existait. */
  async deleteField(tenantId: string, key: string): Promise<boolean> {
    const res = await this.pool.query(`delete from user_fields where tenant_id = $1 and key = $2`, [tenantId, key]);
    return (res.rowCount ?? 0) > 0;
  }
}
