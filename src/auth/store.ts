import type { Pool } from 'pg';

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  passwordHash: string;
}

/** Un espace accessible avec une adresse, tel que l'écran de choix doit le présenter. */
export interface CompteAccessible {
  id: string;
  tenantId: string;
  tenantName: string;
  email: string;
  role: string;
}

/**
 * Ce qu'on trouve derrière une adresse : UN mot de passe, et un ou plusieurs espaces.
 *
 * C'est le changement de fond du multi-espaces. Avant, une adresse valait un compte et le login rendait
 * directement ce compte ; désormais l'adresse porte l'authentification, et les espaces en découlent.
 */
export interface EmailIdentity {
  /** Hash à vérifier. Une adresse sans mot de passe (invitation en attente) ne peut pas se connecter. */
  passwordHash: string;
  /** Espaces accessibles. JAMAIS vide : une identité sans compte actif n'est pas rendue. */
  comptes: CompteAccessible[];
}

export interface UserAuthStore {
  /**
   * Identité d'une adresse : son mot de passe et ses espaces. `null` = adresse inconnue, sans mot de passe,
   * ou dont tous les comptes sont révoqués. L'appelant répond la même chose dans les trois cas, pour ne pas
   * révéler lequel s'applique.
   */
  findIdentity(email: string): Promise<EmailIdentity | null>;
}

/** Lecture des comptes pour l'auth. Une adresse sans mot de passe ne peut pas se connecter. */
export class PgUserAuthStore implements UserAuthStore {
  constructor(private readonly pool: Pool) {}

  async findIdentity(email: string): Promise<EmailIdentity | null> {
    const res = await this.pool.query<{
      password_hash: string | null;
      user_id: string;
      tenant_id: string;
      tenant_name: string;
      email: string;
      role: string;
    }>(
      // Le mot de passe vient de l'IDENTITÉ (migration 0072) : une adresse = un mot de passe, quel que soit
      // le nombre d'espaces. `users.password_hash` n'est plus lu ici.
      //
      // `disabled_at is null` : un compte révoqué ne s'authentifie pas et n'apparaît pas dans le choix. Si
      // TOUS les comptes d'une adresse sont révoqués, la requête ne rend rien, et l'appelant répond comme
      // pour une adresse inconnue.
      //
      // Trié par nom d'espace : l'ordre de l'écran de choix doit être stable d'une connexion à l'autre,
      // sinon on finit par cliquer au mauvais endroit par habitude.
      `select i.password_hash, u.id as user_id, u.tenant_id, t.name as tenant_name, u.email, u.role
         from identities i
         join users u on u.identity_id = i.id
         join tenants t on t.id = u.tenant_id
        where lower(i.email) = lower($1) and u.disabled_at is null
        order by t.name, u.id`,
      [email],
    );
    const hash = res.rows[0]?.password_hash;
    if (!hash) return null;
    return {
      passwordHash: hash,
      comptes: res.rows.map((r) => ({
        id: r.user_id, tenantId: r.tenant_id, tenantName: r.tenant_name, email: r.email, role: r.role,
      })),
    };
  }
}
