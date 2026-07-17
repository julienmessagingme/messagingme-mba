import type { Pool } from 'pg';

export type IdempotencyClaim =
  | { claimed: true }
  | { claimed: false; pending: true }
  | { claimed: false; sendId: string; response: unknown };

/**
 * Idempotence des envois API (Idempotency-Key obligatoire). `claim` pose atomiquement la ligne (contrainte
 * unique (tenant, key)) : premier arrivé -> `claimed:true` (traiter) ; sinon la ligne existe déjà -> soit
 * `pending` (calcul en cours par une requête concurrente -> 409 retryable), soit `response`+`sendId` (rejeu
 * du rapport caché). `complete` renseigne send_id + réponse ; `release` défait le claim si le traitement échoue
 * (libère la clé pour un vrai retry). Purge à 24h par le worker.
 */
export class PgApiIdempotencyStore {
  constructor(private readonly pool: Pool) {}

  async claim(tenantId: string, key: string): Promise<IdempotencyClaim> {
    const ins = await this.pool.query<{ id: string }>(
      `insert into api_idempotency (tenant_id, idempotency_key) values ($1, $2)
       on conflict (tenant_id, idempotency_key) do nothing
       returning tenant_id as id`,
      [tenantId, key],
    );
    if ((ins.rowCount ?? 0) > 0) return { claimed: true };
    const existing = await this.pool.query<{ send_id: string | null; response: unknown }>(
      `select send_id, response from api_idempotency where tenant_id = $1 and idempotency_key = $2`,
      [tenantId, key],
    );
    const r = existing.rows[0];
    if (!r || r.send_id === null) return { claimed: false, pending: true };
    return { claimed: false, sendId: r.send_id, response: r.response };
  }

  async complete(tenantId: string, key: string, sendId: string, response: unknown): Promise<void> {
    await this.pool.query(
      `update api_idempotency set send_id = $3, response = $4::jsonb where tenant_id = $1 and idempotency_key = $2`,
      [tenantId, key, sendId, JSON.stringify(response)],
    );
  }

  /** Défait un claim resté sans send_id (échec applicatif) pour ne pas bloquer un retry légitime. */
  async release(tenantId: string, key: string): Promise<void> {
    await this.pool.query(
      `delete from api_idempotency where tenant_id = $1 and idempotency_key = $2 and send_id is null`,
      [tenantId, key],
    );
  }

  /** Purge les clés plus vieilles que `ms` (worker). Retourne le nb supprimé. */
  async sweepOlderThan(ms: number): Promise<number> {
    const res = await this.pool.query(
      `delete from api_idempotency where created_at < now() - ($1::bigint || ' milliseconds')::interval`,
      [Math.floor(ms)],
    );
    return res.rowCount ?? 0;
  }
}
