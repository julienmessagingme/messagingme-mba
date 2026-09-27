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
 * Ce qu'on trouve derrière une adresse : un mot de passe, et un ou plusieurs espaces. L'adresse porte
 * l'authentification, les espaces en découlent.
 */
export interface EmailIdentity {
  /** L'identité : c'est elle qui porte le mot de passe et le second facteur. */
  identityId: string;
  /** Hash à vérifier. Une adresse sans mot de passe (invitation en attente) ne peut pas se connecter. */
  passwordHash: string;
  /**
   * L'identité a-t-elle un second facteur actif ? Si oui, la connexion demande son code, quel que soit le
   * rôle. Requis : un faux magasin de test doit dire s'il a un facteur, plutôt qu'un champ absent vaille
   * « non ».
   */
  mfaActif: boolean;
  /** Espaces accessibles. Jamais vide : une identité sans compte actif n'est pas rendue. */
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
      identity_id: string;
      password_hash: string | null;
      mfa_actif: boolean;
      user_id: string;
      tenant_id: string;
      tenant_name: string;
      email: string;
      role: string;
    }>(
      // Le mot de passe vient de l'identité : une adresse, un mot de passe, quel que soit le nombre d'espaces.
      // `disabled_at is null` : un compte révoqué ne s'authentifie pas ; si tous le sont, rien n'est rendu, comme
      // pour une adresse inconnue. Trié par nom d'espace : l'ordre de l'écran de choix reste stable.
      `select i.id as identity_id, i.password_hash, (i.mfa_active_le is not null) as mfa_actif,
              u.id as user_id, u.tenant_id, t.name as tenant_name, u.email, u.role
         from identities i
         join users u on u.identity_id = i.id
         join tenants t on t.id = u.tenant_id
        where lower(i.email) = lower($1) and u.disabled_at is null
        order by t.name, u.id`,
      [email],
    );
    const premiere = res.rows[0];
    const hash = premiere?.password_hash;
    if (!premiere || !hash) return null;
    return {
      identityId: premiere.identity_id,
      passwordHash: hash,
      mfaActif: premiere.mfa_actif,
      comptes: res.rows.map((r) => ({
        id: r.user_id, tenantId: r.tenant_id, tenantName: r.tenant_name, email: r.email, role: r.role,
      })),
    };
  }
}
