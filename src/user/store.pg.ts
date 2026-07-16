import type { Pool } from 'pg';

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  /** true = compte révoqué (login bloqué), réversible. */
  disabled: boolean;
  /** true = invitation en attente (pas encore de mot de passe posé). */
  pending: boolean;
  createdAt: string;
}

/** Résultat d'une mutation de compte gardée par l'invariant « ≥1 admin actif par tenant ». */
export type UserMutation = 'ok' | 'last_admin' | 'not_found';

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

  /**
   * État d'auth courant d'un compte (pour la re-vérification par requête dans requireAuth) :
   * rôle FRAIS + révoqué ? null = compte supprimé. Ferme la fenêtre de staleness du JWT : une
   * révocation/suppression/changement de rôle prend effet immédiatement, la base fait foi.
   */
  async getAuthState(userId: string): Promise<{ role: string; disabled: boolean; tenantStatus: string } | null> {
    const res = await this.pool.query<{ role: string; disabled_at: Date | null; tenant_status: string }>(
      `select u.role, u.disabled_at, t.status as tenant_status
       from users u join tenants t on t.id = u.tenant_id where u.id = $1`,
      [userId],
    );
    const r = res.rows[0];
    return r ? { role: r.role, disabled: r.disabled_at !== null, tenantStatus: r.tenant_status } : null;
  }

  /** Hash de mot de passe courant d'un compte (vérification au changement). null si absent/sans mot de passe. */
  async getPasswordHash(userId: string): Promise<string | null> {
    const res = await this.pool.query<{ password_hash: string | null }>(`select password_hash from users where id = $1`, [userId]);
    return res.rows[0]?.password_hash ?? null;
  }

  /** Profil de l'utilisateur courant (route /me) : email + nom + rôle. null = compte inconnu. */
  async getById(userId: string): Promise<{ email: string; name: string | null; role: string } | null> {
    const res = await this.pool.query<{ email: string; name: string | null; role: string }>(
      `select email, name, role from users where id = $1`,
      [userId],
    );
    const r = res.rows[0];
    return r ? { email: r.email, name: r.name, role: r.role } : null;
  }

  /** Nom d'un espace de travail (tenant) par id : sert à personnaliser l'email d'invitation. null si inconnu. */
  async getTenantName(tenantId: string): Promise<string | null> {
    const res = await this.pool.query<{ name: string }>(`select name from tenants where id = $1`, [tenantId]);
    return res.rows[0]?.name ?? null;
  }

  async list(tenantId: string): Promise<UserRow[]> {
    const res = await this.pool.query<{ id: string; email: string; name: string | null; role: string; disabled_at: Date | null; pending: boolean; created_at: Date }>(
      `select id, email, name, role, disabled_at, (password_hash is null) as pending, created_at from users
       where tenant_id = $1 order by created_at asc`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      role: r.role,
      disabled: r.disabled_at !== null,
      pending: r.pending,
      createdAt: r.created_at.toISOString(),
    }));
  }

  /** Un compte par email, TOUT statut (y compris pending sans mot de passe) : pour le login Google (lié par
   *  email). Distinct de PgUserAuthStore.findByEmail qui exige un mot de passe (login classique). */
  async getByEmail(email: string): Promise<{ id: string; tenantId: string; role: string; disabled: boolean } | null> {
    const res = await this.pool.query<{ id: string; tenant_id: string; role: string; disabled_at: Date | null }>(
      `select id, tenant_id, role, disabled_at from users where lower(email) = lower($1) limit 1`,
      [email],
    );
    const r = res.rows[0];
    return r ? { id: r.id, tenantId: r.tenant_id, role: r.role, disabled: r.disabled_at !== null } : null;
  }

  /** {tenantId, role, email} d'un compte par id : sert à émettre une session après acceptation d'invitation. */
  async getSessionUser(userId: string): Promise<{ tenantId: string; role: string; email: string } | null> {
    const res = await this.pool.query<{ tenant_id: string; role: string; email: string }>(
      `select tenant_id, role, email from users where id = $1`,
      [userId],
    );
    const r = res.rows[0];
    return r ? { tenantId: r.tenant_id, role: r.role, email: r.email } : null;
  }

  /** Crée un compte EN ATTENTE (invitation) : sans mot de passe (login impossible tant que non finalisé via le
   *  lien). L'invité posera son mdp à l'acceptation. 409 (DuplicateEmailError) si l'email est déjà pris. */
  async createPending(tenantId: string, email: string, role: string): Promise<UserRow> {
    try {
      const res = await this.pool.query<{ id: string; email: string; name: string | null; role: string; created_at: Date }>(
        `insert into users (tenant_id, email, name, role, password_hash)
         values ($1, $2, null, $3, null)
         returning id, email, name, role, created_at`,
        [tenantId, email, role],
      );
      const r = res.rows[0]!;
      return { id: r.id, email: r.email, name: r.name, role: r.role, disabled: false, pending: true, createdAt: r.created_at.toISOString() };
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23505') throw new DuplicateEmailError();
      throw err;
    }
  }

  /** Pose (ou écrase) le hash de mot de passe d'un compte : finalisation d'invitation, reset. true si le user existe. */
  async setPassword(userId: string, passwordHash: string): Promise<boolean> {
    const res = await this.pool.query(`update users set password_hash = $2 where id = $1`, [userId, passwordHash]);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Inscription LIBRE : crée un espace (tenant) + son admin en UNE transaction (jamais de tenant orphelin sans
   * admin). `passwordHash` null = compte Google-only (login mot de passe impossible, Google OK). 409 si l'email
   * est déjà pris (rollback -> pas de tenant créé pour rien).
   */
  async createTenantWithAdmin(workspaceName: string, admin: { email: string; name: string | null; passwordHash: string | null }): Promise<{ tenantId: string; userId: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const t = await client.query<{ id: string }>(`insert into tenants (name) values ($1) returning id`, [workspaceName]);
      const tenantId = t.rows[0]!.id;
      const u = await client.query<{ id: string }>(
        `insert into users (tenant_id, email, name, role, password_hash) values ($1, $2, $3, 'admin', $4) returning id`,
        [tenantId, admin.email, admin.name, admin.passwordHash],
      );
      await client.query('commit');
      return { tenantId, userId: u.rows[0]!.id };
    } catch (err) {
      await client.query('rollback').catch(() => {});
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23505') throw new DuplicateEmailError();
      throw err;
    } finally {
      client.release();
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
  async setRole(tenantId: string, userId: string, role: string): Promise<UserMutation> {
    const upd = await this.pool.query(
      `update users set role = $3
         where id = $1 and tenant_id = $2
           and ($3 = 'admin' or role = 'agent' or disabled_at is not null
                or (select count(*) from users where tenant_id = $2 and role = 'admin' and disabled_at is null) > 1)`,
      [userId, tenantId, role],
    );
    if ((upd.rowCount ?? 0) > 0) return 'ok';
    // rowCount 0 : soit l'id n'existe pas (autre tenant/inconnu), soit l'invariant a bloqué la MAJ.
    const exists = await this.pool.query(`select 1 from users where id = $1 and tenant_id = $2`, [userId, tenantId]);
    return (exists.rowCount ?? 0) > 0 ? 'last_admin' : 'not_found';
  }

  /**
   * Révoque (disabled=true) ou réactive (false) un compte DU tenant. La révocation d'un admin est
   * refusée si c'est le DERNIER admin ACTIF (invariant « ≥1 admin actif », compté en base). La
   * réactivation est toujours permise (elle ajoute de la capacité admin, aucun risque de lockout).
   * (Même course TOCTOU théorique que setRole : deux révoc/suppr concurrentes sur 2 admins actifs
   *  distincts pourraient chacune voir count>1. Négligeable ; à durcir via lock si le volume monte.)
   */
  async setDisabled(tenantId: string, userId: string, disabled: boolean): Promise<UserMutation> {
    if (!disabled) {
      const upd = await this.pool.query(`update users set disabled_at = null where id = $1 and tenant_id = $2`, [userId, tenantId]);
      return (upd.rowCount ?? 0) > 0 ? 'ok' : 'not_found';
    }
    const upd = await this.pool.query(
      `update users set disabled_at = now()
         where id = $1 and tenant_id = $2
           and (role <> 'admin' or disabled_at is not null
                or (select count(*) from users where tenant_id = $2 and role = 'admin' and disabled_at is null) > 1)`,
      [userId, tenantId],
    );
    if ((upd.rowCount ?? 0) > 0) return 'ok';
    const exists = await this.pool.query(`select 1 from users where id = $1 and tenant_id = $2`, [userId, tenantId]);
    return (exists.rowCount ?? 0) > 0 ? 'last_admin' : 'not_found';
  }

  /**
   * Supprime définitivement un compte DU tenant. Refusé si c'est le dernier admin ACTIF (même
   * invariant que la révocation). Aucune FK ne référence users -> pas de violation à la suppression.
   */
  async deleteUser(tenantId: string, userId: string): Promise<UserMutation> {
    const del = await this.pool.query(
      `delete from users
         where id = $1 and tenant_id = $2
           and (role <> 'admin' or disabled_at is not null
                or (select count(*) from users where tenant_id = $2 and role = 'admin' and disabled_at is null) > 1)`,
      [userId, tenantId],
    );
    if ((del.rowCount ?? 0) > 0) return 'ok';
    const exists = await this.pool.query(`select 1 from users where id = $1 and tenant_id = $2`, [userId, tenantId]);
    return (exists.rowCount ?? 0) > 0 ? 'last_admin' : 'not_found';
  }
}
