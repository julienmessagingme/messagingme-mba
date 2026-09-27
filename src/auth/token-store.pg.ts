import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { sha256Hex } from '../lib/signature';

export type TokenPurpose = 'invite' | 'reset';

/**
 * Jetons à usage unique (invitation d'équipe, réinitialisation de mot de passe). `create` rend le jeton en
 * clair (pour le lien d'e-mail) et 🔴 ne stocke que son hash : sha256 suffit, le jeton étant 256 bits
 * aléatoires, pas un secret humain. `consume` valide et marque utilisé atomiquement (`used_at is null` dans
 * l'UPDATE) : pas de double consommation, même en concurrence.
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
