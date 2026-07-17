import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { sha256Hex } from '../lib/signature';

export interface ApiKeyRow {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Ce que le preHandler /v1 a besoin de résoudre pour authentifier une requête (interface étroite). */
export interface ApiKeyLookup {
  findActiveByHash(hash: string): Promise<{ id: string; tenantId: string; scopes: string[] } | null>;
  touchLastUsed(id: string): Promise<void>;
}

/** Préfixe de clé (repère visuel + filtre : une chaîne sans ce préfixe n'est même pas hashée). */
export const API_KEY_PREFIX = 'mba_';

/**
 * Clés d'API par tenant. `create` renvoie la clé EN CLAIR une seule fois (à copier par le client) mais ne
 * persiste que son hash sha256 (comme PgAuthTokenStore). Le lookup se fait par hash sur un index unique :
 * pas de comparaison en mémoire d'un secret -> pas de canal de timing à protéger. `listByTenant` ne renvoie
 * JAMAIS le hash.
 */
export class PgApiKeyStore implements ApiKeyLookup {
  constructor(private readonly pool: Pool) {}

  async create(tenantId: string, name: string, scopes: string[]): Promise<{ id: string; key: string }> {
    const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const res = await this.pool.query<{ id: string }>(
      `insert into api_keys (tenant_id, key_hash, name, scopes) values ($1, $2, $3, $4) returning id`,
      [tenantId, sha256Hex(key), name, scopes],
    );
    return { id: res.rows[0]!.id, key };
  }

  async findActiveByHash(hash: string): Promise<{ id: string; tenantId: string; scopes: string[] } | null> {
    const res = await this.pool.query<{ id: string; tenant_id: string; scopes: string[] }>(
      `select id, tenant_id, scopes from api_keys where key_hash = $1 and revoked_at is null limit 1`,
      [hash],
    );
    const r = res.rows[0];
    return r ? { id: r.id, tenantId: r.tenant_id, scopes: r.scopes ?? [] } : null;
  }

  async touchLastUsed(id: string): Promise<void> {
    await this.pool.query(`update api_keys set last_used_at = now() where id = $1`, [id]);
  }

  /** Révoque une clé du tenant (idempotent : false si déjà révoquée ou inconnue). */
  async revoke(tenantId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      `update api_keys set revoked_at = now() where id = $1 and tenant_id = $2 and revoked_at is null`,
      [id, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Liste les clés du tenant SANS jamais exposer le hash (ni le clair, qu'on n'a pas). */
  async listByTenant(tenantId: string): Promise<ApiKeyRow[]> {
    const res = await this.pool.query<{ id: string; name: string; scopes: string[]; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }>(
      `select id, name, scopes, created_at, last_used_at, revoked_at from api_keys
       where tenant_id = $1 order by created_at desc`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      scopes: r.scopes ?? [],
      createdAt: r.created_at.toISOString(),
      lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
      revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
    }));
  }
}
