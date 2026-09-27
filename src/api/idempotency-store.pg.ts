import type { Pool } from 'pg';
import { DUREE_CLE_IDEMPOTENCE_MS } from './idempotence';

export type IdempotencyClaim =
  | { claimed: true }
  | { claimed: false; pending: true }
  | { claimed: false; reused: true }
  | { claimed: false; sendId: string; response: unknown };

/** La ligne d'une clé déjà posée, telle que la base la rend. */
export interface LigneIdempotence {
  send_id: string | null;
  response: unknown;
  request_hash: string | null;
}

/**
 * Ce que vaut une clé déjà posée, pour le corps présenté (pure, testée sans base). L'empreinte passe avant
 * tout : une clé qui a servi pour un autre corps est `reused`, fini ou en cours. Une ligne sans empreinte
 * (ancienne) rejoue son rapport ; une ligne absente (libérée entre-temps) vaut « en cours », le client
 * réessaiera.
 */
export function verdictLigne(r: LigneIdempotence | undefined, empreinte: string): IdempotencyClaim {
  if (!r) return { claimed: false, pending: true };
  if (r.request_hash !== null && r.request_hash !== empreinte) return { claimed: false, reused: true };
  if (r.send_id === null) return { claimed: false, pending: true };
  return { claimed: false, sendId: r.send_id, response: r.response };
}

/**
 * Idempotence des envois API (clé obligatoire). `claim` pose atomiquement la ligne avec l'empreinte du corps
 * (unique (tenant, key)) : premier arrivé, `claimed:true` ; sinon `verdictLigne` dit `reused` (422),
 * `pending` (409, à réessayer) ou rejoue le rapport. `complete` renseigne send_id et réponse ; `release`
 * défait le claim si le traitement échoue. Une clé vit exactement 24 h ; la purge n'est que le ménage.
 */
export class PgApiIdempotencyStore {
  constructor(private readonly pool: Pool) {}

  async claim(tenantId: string, key: string, empreinte: string): Promise<IdempotencyClaim> {
    // La clé vit 24 h, pas « jusqu'à la prochaine purge » (horaire) : une ligne expirée est retirée avant
    // l'insertion, et la clé redevient libre à l'heure exacte.
    await this.pool.query(
      `delete from api_idempotency
       where tenant_id = $1 and idempotency_key = $2 and created_at < now() - ($3::bigint || ' milliseconds')::interval`,
      [tenantId, key, DUREE_CLE_IDEMPOTENCE_MS],
    );
    const ins = await this.pool.query<{ id: string }>(
      `insert into api_idempotency (tenant_id, idempotency_key, request_hash) values ($1, $2, $3)
       on conflict (tenant_id, idempotency_key) do nothing
       returning tenant_id as id`,
      [tenantId, key, empreinte],
    );
    if ((ins.rowCount ?? 0) > 0) return { claimed: true };
    const existing = await this.pool.query<LigneIdempotence>(
      `select send_id, response, request_hash from api_idempotency where tenant_id = $1 and idempotency_key = $2`,
      [tenantId, key],
    );
    return verdictLigne(existing.rows[0], empreinte);
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

  /**
   * Purge les clés plus vieilles que `ms` (worker) ; rend le nombre supprimé. 🔴 La fenêtre ne descend jamais
   * sous la vie d'une clé (`DUREE_CLE_IDEMPOTENCE_MS`) : purgée plus tôt, une clé redeviendrait libre et un
   * rejeu enverrait deux fois.
   */
  async sweepOlderThan(ms: number): Promise<number> {
    const res = await this.pool.query(
      `delete from api_idempotency where created_at < now() - ($1::bigint || ' milliseconds')::interval`,
      [Math.max(Math.floor(ms), DUREE_CLE_IDEMPOTENCE_MS)],
    );
    return res.rowCount ?? 0;
  }
}
