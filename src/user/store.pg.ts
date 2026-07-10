import type { Pool } from 'pg';

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  createdAt: string;
}

export interface CreateUserInput {
  email: string;
  name: string | null;
  passwordHash: string;
  role: string;
}

/** Email déjà pris (violation de l'unicité globale lower(email)). Mappé en 409 côté route. */
export class DuplicateEmailError extends Error {
  constructor() {
    super('email déjà utilisé');
    this.name = 'DuplicateEmailError';
  }
}

/**
 * Gestion des comptes de la console (onglet Admin). Toutes les opérations sont scopées au
 * tenant : un admin ne voit et ne modifie que les comptes de SON tenant (pas d'accès cross-tenant).
 * On ne renvoie JAMAIS le password_hash.
 */
export class PgUserStore {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string): Promise<UserRow[]> {
    const res = await this.pool.query<{ id: string; email: string; name: string | null; role: string; created_at: Date }>(
      `select id, email, name, role, created_at from users
       where tenant_id = $1 order by created_at asc`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      role: r.role,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async create(tenantId: string, input: CreateUserInput): Promise<UserRow> {
    try {
      const res = await this.pool.query<{ id: string; email: string; name: string | null; role: string; created_at: Date }>(
        `insert into users (tenant_id, email, name, role, password_hash)
         values ($1, $2, $3, $4, $5)
         returning id, email, name, role, created_at`,
        [tenantId, input.email, input.name, input.role, input.passwordHash],
      );
      const r = res.rows[0]!;
      return { id: r.id, email: r.email, name: r.name, role: r.role, createdAt: r.created_at.toISOString() };
    } catch (err) {
      // 23505 = unique_violation : email déjà pris (index global users_email_lower_unique ou (tenant,email)).
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23505') {
        throw new DuplicateEmailError();
      }
      throw err;
    }
  }

  /**
   * Change le rôle d'un compte DU tenant, en préservant l'invariant « ≥1 admin par tenant ».
   * L'UPDATE est gardé : une rétrogradation admin->agent du DERNIER admin est refusée (le
   * sous-select compte les admins EN BASE, donc l'invariant tient même si l'appelant agit avec un
   * JWT admin périmé — la base fait foi, pas le token). Retour :
   *  - 'updated'   : rôle appliqué.
   *  - 'last_admin': refusé, ce serait le dernier admin rétrogradé.
   *  - 'not_found' : id inconnu / autre tenant.
   * (Course théorique : deux rétrogradations croisées simultanées sur READ COMMITTED pourraient
   *  toutes deux voir count>1. Négligeable ici — 2 admins qui se rétrogradent à la milliseconde —
   *  et le chemin réaliste, le JWT périmé, est fermé. À revoir si on ajoute token_version.)
   */
  async setRole(tenantId: string, userId: string, role: string): Promise<'updated' | 'last_admin' | 'not_found'> {
    const upd = await this.pool.query(
      `update users set role = $3
         where id = $1 and tenant_id = $2
           and ($3 = 'admin' or role = 'agent'
                or (select count(*) from users where tenant_id = $2 and role = 'admin') > 1)`,
      [userId, tenantId, role],
    );
    if ((upd.rowCount ?? 0) > 0) return 'updated';
    // rowCount 0 : soit l'id n'existe pas (autre tenant/inconnu), soit l'invariant a bloqué la MAJ.
    const exists = await this.pool.query(`select 1 from users where id = $1 and tenant_id = $2`, [userId, tenantId]);
    return (exists.rowCount ?? 0) > 0 ? 'last_admin' : 'not_found';
  }
}
