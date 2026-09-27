import type { Pool } from 'pg';
import { deriveTenantCode } from './code';

/**
 * Code client stable d'un espace, lu dans `tenants.public_code`. Absent : dérivé de l'uuid et persisté (idempotent) ;
 * une pose concurrente est absorbée (update seulement si null, puis relecture).
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
