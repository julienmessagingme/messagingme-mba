import type { Pool } from 'pg';
import type { UserFieldStore } from './fields';
import type { UserFieldDef, UserFieldType } from './types';
import { makeCode } from '../ids/code';
import { resolveTenantCode } from '../ids/tenant-code';

/** Store Postgres des champs perso (user fields) par tenant. */
export class PgUserFieldStore implements UserFieldStore {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string): Promise<UserFieldDef[]> {
    const res = await this.pool.query<{ key: string; label: string; type: UserFieldType; code: string | null }>(
      `select key, label, type, code from user_fields where tenant_id = $1 order by key`,
      [tenantId],
    );
    return res.rows.map((r) => ({ key: r.key, label: r.label, type: r.type, code: r.code }));
  }

  async upsert(tenantId: string, def: UserFieldDef): Promise<void> {
    const code = makeCode('fld', await resolveTenantCode(this.pool, tenantId));
    await this.pool.query(
      `insert into user_fields (tenant_id, key, label, type, code) values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, key) do nothing`,
      [tenantId, def.key, def.label, def.type, code],
    );
  }

  /** Crée une définition de champ. 'exists' (409 amont) si la clé existe déjà (pas d'écrasement silencieux). */
  async create(tenantId: string, def: UserFieldDef): Promise<'created' | 'exists'> {
    const code = makeCode('fld', await resolveTenantCode(this.pool, tenantId));
    const res = await this.pool.query(
      `insert into user_fields (tenant_id, key, label, type, code) values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, key) do nothing`,
      [tenantId, def.key, def.label, def.type, code],
    );
    return (res.rowCount ?? 0) > 0 ? 'created' : 'exists';
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
