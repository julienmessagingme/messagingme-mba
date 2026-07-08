import type { Pool } from 'pg';

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  passwordHash: string;
}

export interface UserAuthStore {
  findByEmail(email: string): Promise<AuthUser | null>;
}

/** Lecture des comptes pour l'auth. Un user sans password_hash ne peut pas se connecter. */
export class PgUserAuthStore implements UserAuthStore {
  constructor(private readonly pool: Pool) {}

  async findByEmail(email: string): Promise<AuthUser | null> {
    const res = await this.pool.query<{
      id: string;
      tenant_id: string;
      email: string;
      role: string;
      password_hash: string | null;
    }>(
      // Unicité globale insensible à la casse (index users_email_lower_unique, migration 0010) :
      // un email = un compte. LIMIT 1 par prudence ; lower() pour matcher l'index.
      `select id, tenant_id, email, role, password_hash from users
       where lower(email) = lower($1) limit 1`,
      [email],
    );
    const r = res.rows[0];
    if (!r || !r.password_hash) return null;
    return { id: r.id, tenantId: r.tenant_id, email: r.email, role: r.role, passwordHash: r.password_hash };
  }
}
