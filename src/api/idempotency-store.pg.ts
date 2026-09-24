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
 * CE QUE VAUT UNE CLÉ DÉJÀ POSÉE, pour le corps qu'on présente. Pure : c'est la décision du magasin, testée
 * sans base (`tests/api-idempotence.test.ts`).
 *
 * 🔴 L'EMPREINTE PASSE AVANT TOUT LE RESTE : une clé qui a servi pour un AUTRE corps est `reused`, que son
 * calcul soit fini ou en cours. Rejouer le rapport du premier ferait croire à l'appelant que le sien est parti.
 *
 * ⚠️ Une ligne d'avant la migration (`request_hash` null) rejoue son rapport comme avant : on ne sait pas ce
 * qu'elle a reçu, et elle disparaît avec la purge des 24 h.
 *
 * ⚠️ Une ligne ABSENTE (libérée par un `release` entre l'insertion ratée et la lecture) vaut « en cours » :
 * le client réessaie, et prendra la clé.
 */
export function verdictLigne(r: LigneIdempotence | undefined, empreinte: string): IdempotencyClaim {
  if (!r) return { claimed: false, pending: true };
  if (r.request_hash !== null && r.request_hash !== empreinte) return { claimed: false, reused: true };
  if (r.send_id === null) return { claimed: false, pending: true };
  return { claimed: false, sendId: r.send_id, response: r.response };
}

/**
 * Idempotence des envois API (clé obligatoire). `claim` pose atomiquement la ligne AVEC l'empreinte du corps
 * (contrainte unique (tenant, key)) : premier arrivé -> `claimed:true` (traiter) ; sinon `verdictLigne` dit
 * `reused` (autre corps, 422), `pending` (calcul en cours, 409 retryable) ou rejoue le rapport. `complete`
 * renseigne send_id + réponse ; `release` défait le claim si le traitement échoue (libère la clé pour un vrai
 * retry). Une clé vit EXACTEMENT 24 h (le claim retire la ligne expirée) ; la purge du worker n'est que le
 * ménage.
 */
export class PgApiIdempotencyStore {
  constructor(private readonly pool: Pool) {}

  async claim(tenantId: string, key: string, empreinte: string): Promise<IdempotencyClaim> {
    // 🔴 LA CLÉ VIT 24 H, PAS « JUSQU'À LA PROCHAINE PURGE » : la purge passe toutes les heures, donc sans ceci
    // une clé vivait entre 24 et 25 h, et le message du 422 promettait 24. Une ligne expirée est retirée avant
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

  /** Purge les clés plus vieilles que `ms` (worker). Retourne le nb supprimé. */
  /**
   * Le ménage des clés expirées. 🔴 La fenêtre ne descend JAMAIS sous la vie d'une clé
   * (`DUREE_CLE_IDEMPOTENCE_MS`) : purgée plus tôt, une clé redeviendrait libre et un rejeu enverrait deux fois.
   */
  async sweepOlderThan(ms: number): Promise<number> {
    const res = await this.pool.query(
      `delete from api_idempotency where created_at < now() - ($1::bigint || ' milliseconds')::interval`,
      [Math.max(Math.floor(ms), DUREE_CLE_IDEMPOTENCE_MS)],
    );
    return res.rowCount ?? 0;
  }
}
