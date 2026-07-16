import type { Pool } from 'pg';
import { deriveTenantCode } from './code';

/**
 * Code client STABLE d'un tenant (racine des codes d'entités). Lu depuis `tenants.public_code`. S'il est absent
 * (tenant créé avant le backfill), on le dérive de l'uuid (déterministe -> immuable) et on le PERSISTE (self-heal
 * idempotent) : ainsi une entité créée avant que le backfill n'ait tourné obtient quand même une racine stable.
 * Une pose concurrente est absorbée (l'update ne pose que si toujours null, puis on relit la valeur retenue).
 */
export async function resolveTenantCode(pool: Pool, tenantId: string): Promise<string> {
  const r = await pool.query<{ public_code: string | null }>('select public_code from tenants where id = $1', [tenantId]);
  const existing = r.rows[0]?.public_code;
  if (existing) return existing;
  const code = deriveTenantCode(tenantId);
  await pool.query('update tenants set public_code = $2 where id = $1 and public_code is null', [tenantId, code]);
  const after = await pool.query<{ public_code: string | null }>('select public_code from tenants where id = $1', [tenantId]);
  return after.rows[0]?.public_code ?? code;
}
