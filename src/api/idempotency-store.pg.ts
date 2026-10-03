import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { DUREE_CLE_EN_COURS_MAX_MS, DUREE_CLE_IDEMPOTENCE_MS } from './idempotence';

/**
 * `jeton` : la preuve que CETTE pose est la nôtre. `complete` et `release` l'exigent, et ne touchent que la
 * ligne qui le porte : une clé abandonnée puis reprise par un autre appel n'est plus à nous.
 */
export type IdempotencyClaim =
  | { claimed: true; jeton: string }
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
 * et un jeton (unique (tenant, key)) : premier arrivé, `claimed:true` avec son jeton ; sinon `verdictLigne`
 * dit `reused` (422), `pending` (409, à réessayer) ou rejoue le rapport. `complete` scelle send_id et
 * réponse ; `release` défait le claim si le traitement échoue. Une clé vit exactement 24 h ; la purge n'est
 * que le ménage.
 *
 * 🔴 UNE CLÉ EN COURS EST UN VERROU SUR L'ENVOI, donc elle a les pièces d'un verrou (`src/campaign/run-lock.ts`) :
 * un BAIL (`DUREE_CLE_EN_COURS_MAX_MS` : au-delà, la pose est abandonnée et `claim` la retire) et un JETON DE
 * GARDE (seul le porteur scelle ou libère). Sans le bail, une copie tuée entre pose et scellement bloquait la
 * clé 24 h (trois arrêts brutaux sur cinq au second banc) ; sans le jeton, le bail rendrait possible le double
 * envoi : un traitement lent scellerait ou libérerait la ligne de celui qui l'a reprise.
 */
export class PgApiIdempotencyStore {
  constructor(private readonly pool: Pool) {}

  async claim(tenantId: string, key: string, empreinte: string): Promise<IdempotencyClaim> {
    // La clé vit 24 h, pas « jusqu'à la prochaine purge » (horaire) : une ligne expirée est retirée avant
    // l'insertion, et la clé redevient libre à l'heure exacte. Une pose ABANDONNÉE (en cours au-delà du bail)
    // l'est aussi ; une clé SCELLÉE, jamais avant ses 24 h.
    await this.pool.query(
      `delete from api_idempotency
       where tenant_id = $1 and idempotency_key = $2
         and (created_at < now() - ($3::bigint || ' milliseconds')::interval
              or (send_id is null and created_at < now() - ($4::bigint || ' milliseconds')::interval))`,
      [tenantId, key, DUREE_CLE_IDEMPOTENCE_MS, DUREE_CLE_EN_COURS_MAX_MS],
    );
    const jeton = randomUUID();
    const ins = await this.pool.query<{ id: string }>(
      `insert into api_idempotency (tenant_id, idempotency_key, request_hash, jeton) values ($1, $2, $3, $4)
       on conflict (tenant_id, idempotency_key) do nothing
       returning tenant_id as id`,
      [tenantId, key, empreinte, jeton],
    );
    if ((ins.rowCount ?? 0) > 0) return { claimed: true, jeton };
    const existing = await this.pool.query<LigneIdempotence>(
      `select send_id, response, request_hash from api_idempotency where tenant_id = $1 and idempotency_key = $2`,
      [tenantId, key],
    );
    return verdictLigne(existing.rows[0], empreinte);
  }

  /**
   * La clé est-elle encore à ce porteur, et encore en cours ? La route le demande juste avant le geste
   * irréversible (créer la campagne) : une pose reprise après abandon n'en crée pas une seconde.
   */
  async possede(tenantId: string, key: string, jeton: string): Promise<boolean> {
    const res = await this.pool.query(
      `select 1 from api_idempotency where tenant_id = $1 and idempotency_key = $2 and jeton = $3 and send_id is null`,
      [tenantId, key, jeton],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Scelle la clé, pour ce porteur seulement. Rend `false` si elle ne lui appartient plus (abandonnée puis
   * reprise) : l'appelant ne doit alors PAS lancer sa campagne, l'autre appel enverra.
   */
  async complete(tenantId: string, key: string, jeton: string, sendId: string, response: unknown): Promise<boolean> {
    const res = await this.pool.query(
      `update api_idempotency set send_id = $4, response = $5::jsonb
       where tenant_id = $1 and idempotency_key = $2 and jeton = $3 and send_id is null`,
      [tenantId, key, jeton, sendId, JSON.stringify(response)],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Défait un claim resté sans send_id (échec applicatif) pour ne pas bloquer un retry légitime. Seulement le
   * sien : libérer la pose d'un autre appel laisserait un troisième la prendre pendant que l'autre envoie.
   */
  async release(tenantId: string, key: string, jeton: string): Promise<void> {
    await this.pool.query(
      `delete from api_idempotency where tenant_id = $1 and idempotency_key = $2 and jeton = $3 and send_id is null`,
      [tenantId, key, jeton],
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
