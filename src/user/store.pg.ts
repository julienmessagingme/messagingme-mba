import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';
import { makeCode, deriveTenantCode } from '../ids/code';
import { resolveTenantCode } from '../ids/tenant-code';

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  /** Code public « usr_<client>_<ulid> ». null tant que le backfill n'a pas tourné. */
  code?: string | null;
  /** true = compte révoqué (login bloqué), réversible. */
  disabled: boolean;
  /** true = invitation en attente (pas encore de mot de passe posé). */
  pending: boolean;
  createdAt: string;
  /** Dernière connexion réussie (ISO). null = jamais connecté : pas de repli sur `createdAt`, une date d'inscription
   *  n'est pas une date de connexion. */
  lastLoginAt: string | null;
}

/** Résultat d'une mutation de compte gardée par l'invariant « au moins un admin actif par espace ». */
export type UserMutation = 'ok' | 'last_admin' | 'not_found';

/** Email déjà pris (unicité globale de lower(email)). Traduit en 409 côté route. */
export class DuplicateEmailError extends Error {
  constructor() {
    super('email déjà utilisé');
    this.name = 'DuplicateEmailError';
  }
}

/**
 * Gestion des comptes de la console. 🔴 Toutes les opérations sont filtrées sur l'espace : un admin ne voit et ne
 * modifie que les comptes de son espace. On ne renvoie jamais le password_hash.
 */
export class PgUserStore {
  constructor(private readonly pool: Pool) {}

  /**
   * État d'auth courant d'un compte, relu à chaque requête par requireAuth : rôle frais et révocation. null = compte
   * supprimé. Une révocation, une suppression ou un changement de rôle prend effet tout de suite : la base fait foi,
   * pas le JWT.
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

  /**
   * Hash de mot de passe courant d'un compte, pour vérifier l'ancien au changement. null si absent.
   * 🔴 Lu sur l'identité, comme la connexion (`PgUserAuthStore.findIdentity`) : `setPassword` écrit sur l'identité,
   * et vérifier sur une copie divergente laisserait un compte changer le mot de passe de toute l'adresse. La copie
   * ne sert qu'aux comptes sans identité.
   */
  async getPasswordHash(userId: string): Promise<string | null> {
    const res = await this.pool.query<{ password_hash: string | null }>(
      `select case when u.identity_id is null then u.password_hash else i.password_hash end as password_hash
         from users u left join identities i on i.id = u.identity_id
        where u.id = $1`,
      [userId],
    );
    return res.rows[0]?.password_hash ?? null;
  }

  /**
   * Le mot de passe de l'identité d'une adresse, pour l'inscription : `undefined` si l'adresse n'a pas d'identité,
   * `null` si elle en a une sans mot de passe (invitation en attente, compte Google).
   */
  async motDePasseDeLAdresse(email: string): Promise<string | null | undefined> {
    const res = await this.pool.query<{ password_hash: string | null }>(
      `select password_hash from identities where lower(email) = lower($1)`,
      [email],
    );
    return res.rows.length === 0 ? undefined : res.rows[0]!.password_hash;
  }

  /** Profil de l'utilisateur courant (route /me). null = compte inconnu. */
  async getById(userId: string): Promise<{ email: string; name: string | null; role: string } | null> {
    const res = await this.pool.query<{ email: string; name: string | null; role: string }>(
      `select email, name, role from users where id = $1`,
      [userId],
    );
    const r = res.rows[0];
    return r ? { email: r.email, name: r.name, role: r.role } : null;
  }

  /** Nom d'un espace, pour personnaliser l'email d'invitation. null si inconnu. */
  async getTenantName(tenantId: string): Promise<string | null> {
    const res = await this.pool.query<{ name: string }>(`select name from tenants where id = $1`, [tenantId]);
    return res.rows[0]?.name ?? null;
  }

  /** Renomme un espace (Compte & équipe). `false` = espace inconnu : rien n'a été écrit. */
  async setTenantName(tenantId: string, name: string): Promise<boolean> {
    const res = await this.pool.query(`update tenants set name = $2 where id = $1`, [tenantId, name]);
    return (res.rowCount ?? 0) > 0;
  }

  async list(tenantId: string): Promise<UserRow[]> {
    const res = await this.pool.query<{ id: string; email: string; name: string | null; role: string; code: string | null; disabled_at: Date | null; pending: boolean; created_at: Date; last_login_at: Date | null }>(
      // `pending` veut dire « n'a jamais accepté son invitation » et se lit sur `last_login_at`, jamais sur
      // `password_hash` : un compte Google n'a pas de mot de passe, et trois écrans excluent les comptes en attente.
      `select id, email, name, role, code, disabled_at, (last_login_at is null) as pending, created_at, last_login_at from users
       where tenant_id = $1 order by created_at asc`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      role: r.role,
      code: r.code,
      disabled: r.disabled_at !== null,
      pending: r.pending,
      createdAt: r.created_at.toISOString(),
      lastLoginAt: r.last_login_at?.toISOString() ?? null,
    }));
  }

  /**
   * Horodate la dernière connexion réussie, en fire-and-forget : une panne d'écriture ne doit jamais transformer
   * une authentification valide en 500.
   */
  async touchLastLogin(userId: string): Promise<void> {
    await this.pool.query(`update users set last_login_at = now() where id = $1`, [userId]);
  }

  /**
   * Tous les comptes d'une adresse, quel que soit leur statut, pour la connexion Google (liée par email). Distinct de
   * `PgUserAuthStore.findIdentity`, qui exige un mot de passe. La liste complète laisse la route proposer l'écran
   * de choix, avec le même tri que `findIdentity`.
   */
  async getByEmail(email: string): Promise<Array<{ id: string; tenantId: string; tenantName: string; role: string; disabled: boolean }>> {
    const res = await this.pool.query<{ id: string; tenant_id: string; tenant_name: string; role: string; disabled_at: Date | null }>(
      `select u.id, u.tenant_id, t.name as tenant_name, u.role, u.disabled_at
         from users u
         join tenants t on t.id = u.tenant_id
        where lower(u.email) = lower($1)
        order by t.name, u.id`,
      [email],
    );
    return res.rows.map((r) => ({
      id: r.id, tenantId: r.tenant_id, tenantName: r.tenant_name, role: r.role, disabled: r.disabled_at !== null,
    }));
  }

  /** {tenantId, role, email} d'un compte, pour émettre une session après acceptation d'invitation. */
  async getSessionUser(userId: string): Promise<{ tenantId: string; role: string; email: string } | null> {
    const res = await this.pool.query<{ tenant_id: string; role: string; email: string }>(
      `select tenant_id, role, email from users where id = $1`,
      [userId],
    );
    const r = res.rows[0];
    return r ? { tenantId: r.tenant_id, role: r.role, email: r.email } : null;
  }

  /**
   * Identité d'une adresse : la trouve, ou la crée. Rend son identifiant. Un deuxième espace avec la même adresse
   * réutilise ainsi le mot de passe existant : une adresse, un mot de passe.
   * `on conflict do nothing` puis relecture : deux inscriptions simultanées convergent vers la même identité.
   */
  private async ensureIdentity(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ id: string }>; rowCount: number | null }> },
    email: string,
    passwordHash: string | null,
  ): Promise<string> {
    await client.query(
      `insert into identities (email, password_hash) values ($1, $2)
       on conflict (lower(email)) do nothing`,
      [email, passwordHash],
    );
    const res = await client.query(`select id from identities where lower(email) = lower($1)`, [email]);
    return res.rows[0]!.id;
  }

  /** Crée un compte en attente (invitation), sans mot de passe : connexion impossible avant l'acceptation.
   *  DuplicateEmailError (409) si l'email est déjà pris. */
  async createPending(tenantId: string, email: string, role: string, name?: string): Promise<UserRow> {
    const code = makeCode('usr', await resolveTenantCode(this.pool, tenantId));
    try {
      // Identité créée si l'adresse est nouvelle, réutilisée sinon : l'invité garde le mot de passe qu'il connaît.
      const identityId = await this.ensureIdentity(this.pool, email, null);
      // Le nom saisi par l'admin est posé dès l'invitation, sinon le membre apparaît sous son adresse partout.
      // Absent : `null`, donc le repli `name ?? email`.
      const res = await this.pool.query<{ id: string; email: string; name: string | null; role: string; created_at: Date }>(
        `insert into users (tenant_id, email, name, role, password_hash, code, identity_id)
         values ($1, $2, $6, $3, null, $4, $5)
         returning id, email, name, role, created_at`,
        [tenantId, email, role, code, identityId, name?.trim() === '' ? null : (name?.trim() ?? null)],
      );
      const r = res.rows[0]!;
      return { id: r.id, email: r.email, name: r.name, role: r.role, code, disabled: false, pending: true, createdAt: r.created_at.toISOString(), lastLoginAt: null };
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23505') throw new DuplicateEmailError();
      throw err;
    }
  }

  /**
   * Pose (ou écrase) le mot de passe : finalisation d'invitation, réinitialisation. `true` si le compte existe.
   * 🔴 Écrit sur l'identité, pas sur le compte : une adresse a un seul mot de passe, quel que soit le nombre de ses
   * espaces. `users.password_hash` est mis à jour en miroir, pour qu'un retour arrière ne prive personne du sien.
   */
  async setPassword(userId: string, passwordHash: string): Promise<boolean> {
    return enTransaction(this.pool, async (client) => {
      const res = await client.query(
        `update identities set password_hash = $2
          where id = (select identity_id from users where id = $1)`,
        [userId, passwordHash],
      );
      const miroir = await client.query(`update users set password_hash = $2 where id = $1`, [userId, passwordHash]);
      // L'une ou l'autre écriture suffit : un compte sans identité doit pouvoir poser son mot de passe.
      return (res.rowCount ?? 0) > 0 || (miroir.rowCount ?? 0) > 0;
    });
  }

  /**
   * Inscription libre : crée un espace et son admin en une transaction (jamais d'espace sans admin).
   * `passwordHash` null = compte Google seul. 409 si l'email est déjà pris (rollback, aucun espace créé).
   */
  async createTenantWithAdmin(workspaceName: string, admin: { email: string; name: string | null; passwordHash: string | null }): Promise<{ tenantId: string; userId: string }> {
    try {
      return await enTransaction(this.pool, async (client) => {
        const t = await client.query<{ id: string }>(`insert into tenants (name) values ($1) returning id`, [workspaceName]);
        const tenantId = t.rows[0]!.id;
        // Code client posé à la création (déterministe depuis l'uuid, immuable), puis code du premier admin.
        const tcode = deriveTenantCode(tenantId);
        await client.query(`update tenants set public_code = $2 where id = $1`, [tenantId, tcode]);
        // Même adresse qu'un espace existant : on réutilise son identité, donc son mot de passe.
        const identityId = await this.ensureIdentity(client, admin.email, admin.passwordHash);
        const u = await client.query<{ id: string }>(
          `insert into users (tenant_id, email, name, role, password_hash, code, identity_id) values ($1, $2, $3, 'admin', $4, $5, $6) returning id`,
          [tenantId, admin.email, admin.name, admin.passwordHash, makeCode('usr', tcode), identityId],
        );
        return { tenantId, userId: u.rows[0]!.id };
      });
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23505') throw new DuplicateEmailError();
      throw err;
    }
  }

  /**
   * Pose (ou efface) le nom affiché d'un membre, celui que tous les écrans montrent (`name ?? email`).
   * Une chaîne vide efface (`null`) : un nom vide ferait afficher du blanc au lieu de l'adresse. Aucun invariant
   * d'admin en jeu ici ; la seule garde est l'espace.
   */
  async setName(tenantId: string, userId: string, name: string): Promise<UserMutation> {
    const propre = name.trim();
    const upd = await this.pool.query(
      `update users set name = $3 where id = $1 and tenant_id = $2`,
      [userId, tenantId, propre === '' ? null : propre],
    );
    return (upd.rowCount ?? 0) > 0 ? 'ok' : 'not_found';
  }

  /**
   * Change le rôle d'un compte de l'espace, en préservant « au moins un admin actif ». L'UPDATE est gardé : le
   * sous-select compte les admins en base, donc l'invariant tient même avec un JWT admin périmé. Rend 'ok',
   * 'last_admin' (dernier admin rétrogradé) ou 'not_found' (id inconnu ou autre espace).
   * Course théorique : deux rétrogradations croisées simultanées pourraient toutes deux voir count > 1.
   */
  async setRole(tenantId: string, userId: string, role: string): Promise<UserMutation> {
    const upd = await this.pool.query(
      // `role <> 'admin'` et non `role = 'agent'` : un compte non admin peut changer de rôle sans toucher au nombre
      // d'admins, quel que soit son rôle actuel.
      `update users set role = $3
         where id = $1 and tenant_id = $2
           and ($3 = 'admin' or role <> 'admin' or disabled_at is not null
                or (select count(*) from users where tenant_id = $2 and role = 'admin' and disabled_at is null) > 1)`,
      [userId, tenantId, role],
    );
    if ((upd.rowCount ?? 0) > 0) return 'ok';
    // rowCount 0 : id inconnu (ou autre espace), ou invariant qui a bloqué.
    const exists = await this.pool.query(`select 1 from users where id = $1 and tenant_id = $2`, [userId, tenantId]);
    return (exists.rowCount ?? 0) > 0 ? 'last_admin' : 'not_found';
  }

  /**
   * Révoque ou réactive un compte de l'espace. Révoquer le dernier admin actif est refusé (compté en base) ;
   * réactiver est toujours permis. Même course théorique que setRole.
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
   * 🔴 Supprime définitivement un compte de l'espace, sauf le dernier admin actif.
   *
   * Toute clé étrangère vers `users` doit déclarer son comportement de suppression, sinon ce delete échouera.
   * `on delete set null` ne suffit pas quand la table porte un CHECK sur la colonne mise à null : le consentement
   * d'un outil (`agent_tool_consommateurs`) exige `actif = false or active_par is not null`, et le `set null`
   * ferait échouer tout le delete en 23514. Les consentements de ce compte sont donc éteints d'abord, dans la même
   * transaction ; un admin les réactive depuis l'onglet Outils.
   */
  async deleteUser(tenantId: string, userId: string): Promise<UserMutation> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      // Le CHECK du consentement ferait échouer le delete : on éteint d'abord ce que ce compte avait autorisé.
      const liaisonsActives = await client.query(
        `update agent_tool_consommateurs
            set actif = false, active_par = null, active_le = null, updated_at = now()
          where tenant_id = $2 and active_par = $1 and actif`,
        [userId, tenantId],
      );
      const liaisonsAutonomes = await client.query(
        `update agent_tool_consommateurs
            set autonome = false, autonome_par = null, autonome_le = null, updated_at = now()
          where tenant_id = $2 and autonome_par = $1 and autonome`,
        [userId, tenantId],
      );
      const del = await client.query(
        `delete from users
           where id = $1 and tenant_id = $2
             and (role <> 'admin' or disabled_at is not null
                  or (select count(*) from users where tenant_id = $2 and role = 'admin' and disabled_at is null) > 1)`,
        [userId, tenantId],
      );
      if ((del.rowCount ?? 0) === 0) {
        // Refus ou compte inexistant : rien n'est éteint, un refus ne laisse pas d'outils éteints derrière lui.
        await client.query('rollback');
        const exists = await this.pool.query(`select 1 from users where id = $1 and tenant_id = $2`, [userId, tenantId]);
        return (exists.rowCount ?? 0) > 0 ? 'last_admin' : 'not_found';
      }
      await client.query('commit');
      const eteints = (liaisonsActives.rowCount ?? 0) + (liaisonsAutonomes.rowCount ?? 0);
      // Journalisé : c'est le seul lien entre un départ et un agent devenu muet.
      if (eteints > 0) {
        console.warn(`[users] suppression de ${userId} (tenant ${tenantId}) : ${eteints} reglage(s) d outil d agent desactive(s)`);
      }
      return 'ok';
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
