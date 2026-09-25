import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { sha256Hex } from '../lib/signature';

export type TokenPurpose = 'invite' | 'reset';

/**
 * Tokens à usage unique (invitation d'équipe, réinitialisation de mot de passe). `create` renvoie le token EN
 * CLAIR (à mettre dans le lien email) mais ne persiste que son hash. `consume` valide + marque utilisé de façon
 * ATOMIQUE (`used_at is null` dans le UPDATE) -> pas de double-consommation même en concurrence.
 *
 * Seul le HASH du token est stocké, jamais le clair (comme un mot de passe). sha256 suffit ici : le token est
 * déjà 256 bits aléatoires, pas un secret humain rejouable, donc pas besoin de sel coûteux.
 */
export class PgAuthTokenStore {
  constructor(private readonly pool: Pool) {}

  async create(purpose: TokenPurpose, userId: string, ttlMs: number): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.pool.query(
      `insert into auth_tokens (purpose, token_hash, user_id, expires_at) values ($1, $2, $3, $4)`,
      [purpose, sha256Hex(raw), userId, expiresAt],
    );
    return raw;
  }

  /** Renvoie le user_id si le token est valide (bon purpose, non expiré, non déjà utilisé), sinon null. */
  async consume(purpose: TokenPurpose, raw: string): Promise<string | null> {
    if (!raw) return null;
    const res = await this.pool.query<{ user_id: string }>(
      `update auth_tokens set used_at = now()
       where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now()
       returning user_id`,
      [sha256Hex(raw), purpose],
    );
    return res.rows[0]?.user_id ?? null;
  }
}
