import type { Pool } from 'pg';
import { makeCode, deriveTenantCode } from '../ids/code';
import { resolveTenantCode } from '../ids/tenant-code';

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  /** Code public « usr_<client>_<ulid> » (schéma A). null tant que le backfill n'a pas tourné. */
  code?: string | null;
  /** true = compte révoqué (login bloqué), réversible. */
  disabled: boolean;
  /** true = invitation en attente (pas encore de mot de passe posé). */
  pending: boolean;
  createdAt: string;
  /** Dernière CONNEXION réussie (ISO). null = jamais connecté DEPUIS la migration 0037 : on n'invente pas de
   *  valeur de repli sur `createdAt`, une date d'inscription n'est pas une date de connexion. */
  lastLoginAt: string | null;
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
    const res = await this.pool.query<{ id: string; email: string; name: string | null; role: string; code: string | null; disabled_at: Date | null; pending: boolean; created_at: Date; last_login_at: Date | null }>(
      // 🔴 `pending` VEUT DIRE « N'A JAMAIS ACCEPTÉ SON INVITATION », ET SE LIT SUR `last_login_at`.
      // Il se lisait sur `password_hash is null`, ce qui était FAUX pour tout compte Google : la connexion
      // par Google ne pose aucun mot de passe, donc une personne qui travaille dans la console tous les
      // jours y était annoncée « invitation en attente ». Mesuré en production le 2026-09-12 : deux des
      // quatre comptes, connectés la veille et l'avant-veille, étaient classés en attente.
      // ⚠️ Trois écrans lisaient ce drapeau pour EXCLURE ces personnes de leurs listes (membres d'un
      // scénario, assignation d'une campagne, et le tour de rôle côté serveur) : le défaut ne se voyait pas
      // sur la fiche des comptes, il se voyait par une absence ailleurs, ce qui est la pire forme.
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
   * Horodate la dernière connexion réussie. Appelée en FIRE-AND-FORGET depuis les routes de login : une panne
   * d'écriture (pool saturé, hoquet réseau) ne doit jamais transformer une authentification valide en 500.
   */
  async touchLastLogin(userId: string): Promise<void> {
    await this.pool.query(`update users set last_login_at = now() where id = $1`, [userId]);
  }

  /**
   * TOUS les comptes d'une adresse, TOUT statut (y compris pending sans mot de passe et révoqués) : pour le
   * login Google (lié par email). Distinct de `PgUserAuthStore.findIdentity`, qui exige un mot de passe.
   *
   * 🔴 C'était un `limit 1` sans `order by` : une adresse à deux espaces entrait dans l'un des deux AU HASARD,
   * sans jamais voir l'écran de choix (vécu le 2026-09-25). La liste complète laisse la route décider, et le
   * tri est celui de `findIdentity`, pour que l'écran de choix soit le même quel que soit le bouton.
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

  /** {tenantId, role, email} d'un compte par id : sert à émettre une session après acceptation d'invitation. */
  async getSessionUser(userId: string): Promise<{ tenantId: string; role: string; email: string } | null> {
    const res = await this.pool.query<{ tenant_id: string; role: string; email: string }>(
      `select tenant_id, role, email from users where id = $1`,
      [userId],
    );
    const r = res.rows[0];
    return r ? { tenantId: r.tenant_id, role: r.role, email: r.email } : null;
  }

  /**
   * Identité d'une adresse : la trouve, ou la crée. Rend son identifiant.
   *
   * C'est ce qui fait qu'un DEUXIÈME espace créé avec la même adresse RÉUTILISE le mot de passe existant au
   * lieu d'en demander un nouveau. Sans ce partage, l'utilisateur aurait deux mots de passe pour une seule
   * adresse, ce qui est précisément ce que la conception écarte.
   *
   * `on conflict do nothing` puis relecture : deux inscriptions simultanées avec la même adresse ne doivent
   * pas faire échouer la seconde, elles doivent converger vers la même identité.
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

  /** Crée un compte EN ATTENTE (invitation) : sans mot de passe (login impossible tant que non finalisé via le
   *  lien). L'invité posera son mdp à l'acceptation. 409 (DuplicateEmailError) si l'email est déjà pris. */
  async createPending(tenantId: string, email: string, role: string, name?: string): Promise<UserRow> {
    const code = makeCode('usr', await resolveTenantCode(this.pool, tenantId));
    try {
      // L'identité est créée si l'adresse est nouvelle, RÉUTILISÉE sinon : un invité qui a déjà un compte
      // ailleurs se connectera avec le mot de passe qu'il connaît déjà, sans repasser par le lien.
      const identityId = await this.ensureIdentity(this.pool, email, null);
      // ⚠️ LE NOM EST POSÉ DÈS L'INVITATION quand l'admin l'a saisi : sans lui, le nouveau membre apparaît
      // sous son adresse e-mail dans toute l'Inbox jusqu'à ce que quelqu'un pense à le renommer. Absent ->
      // `null`, donc le repli `name ?? email` d'avant, à l'identique.
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
   *
   * 🔴 Écrit sur l'IDENTITÉ, pas sur le compte : une adresse a UN mot de passe, quel que soit le nombre
   * d'espaces auxquels elle donne accès (migration 0072). Écrire sur le compte produirait le bug
   * « mon mot de passe marche sur un espace et pas sur l'autre », que l'utilisateur ne peut pas comprendre.
   *
   * `users.password_hash` est mis à jour EN MIROIR le temps de la transition : tant que la migration 0073
   * n'est pas appliquée, revenir en arrière ne doit priver personne de son mot de passe.
   */
  async setPassword(userId: string, passwordHash: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const res = await client.query(
        `update identities set password_hash = $2
          where id = (select identity_id from users where id = $1)`,
        [userId, passwordHash],
      );
      const miroir = await client.query(`update users set password_hash = $2 where id = $1`, [userId, passwordHash]);
      await client.query('commit');
      // Le compte existe si l'une OU l'autre écriture a porté : un compte sans identité (donnée antérieure à
      // 0072 et non reprise) doit continuer à pouvoir poser son mot de passe.
      return (res.rowCount ?? 0) > 0 || (miroir.rowCount ?? 0) > 0;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
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
      // Racine « code client » posée à la création (déterministe depuis l'uuid, immuable) + code du 1er admin.
      const tcode = deriveTenantCode(tenantId);
      await client.query(`update tenants set public_code = $2 where id = $1`, [tenantId, tcode]);
      // Même adresse qu'un espace existant -> on RÉUTILISE son identité, donc son mot de passe. C'est le
      // cœur du multi-espaces : « une adresse, un mot de passe, plusieurs espaces ».
      const identityId = await this.ensureIdentity(client, admin.email, admin.passwordHash);
      const u = await client.query<{ id: string }>(
        `insert into users (tenant_id, email, name, role, password_hash, code, identity_id) values ($1, $2, $3, 'admin', $4, $5, $6) returning id`,
        [tenantId, admin.email, admin.name, admin.passwordHash, makeCode('usr', tcode), identityId],
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
   *  - 'ok'        : rôle appliqué.
   *  - 'last_admin': refusé, ce serait le dernier admin rétrogradé.
   *  - 'not_found' : id inconnu / autre tenant.
   * (Course théorique : deux rétrogradations croisées simultanées sur READ COMMITTED pourraient
   *  toutes deux voir count>1. Négligeable ici — 2 admins qui se rétrogradent à la milliseconde —
   *  et le chemin réaliste, le JWT périmé, est fermé. À revoir si on ajoute token_version.)
   */
  /**
   * Pose (ou efface) le NOM affiché d'un membre.
   *
   * 🔴 CE NOM EST CE QUE TOUT LE MONDE VOIT, et son absence est la raison pour laquelle l'Inbox affichait des
   * ADRESSES E-MAIL partout : la charge par membre, le sélecteur d'affectation, « suivi par… » font tous
   * `name ?? email` depuis toujours, mais rien ne permettait de poser ce nom. La colonne existait, personne
   * ne l'écrivait jamais.
   *
   * ⚠️ UNE CHAÎNE VIDE EFFACE (elle devient `null`), elle n'enregistre pas un nom vide : sans ça, le repli
   * `name ?? email` cesserait de s'appliquer et les écrans afficheraient du blanc à la place de l'adresse,
   * ce qui est pire que l'adresse.
   *
   * ⚠️ AUCUN INVARIANT À PROTÉGER ICI, contrairement à `setRole` et `setDisabled` : renommer quelqu'un ne peut
   * pas faire tomber le nombre d'administrateurs. La seule garde est le tenant.
   */
  async setName(tenantId: string, userId: string, name: string): Promise<UserMutation> {
    const propre = name.trim();
    const upd = await this.pool.query(
      `update users set name = $3 where id = $1 and tenant_id = $2`,
      [userId, tenantId, propre === '' ? null : propre],
    );
    return (upd.rowCount ?? 0) > 0 ? 'ok' : 'not_found';
  }

  async setRole(tenantId: string, userId: string, role: string): Promise<UserMutation> {
    const upd = await this.pool.query(
      // `role <> 'admin'` et non `role = 'agent'` : le compte visé n'étant PAS admin, le changer ne peut pas
      // faire tomber le nombre d'admins, quel que soit son rôle. Écrit en dur sur 'agent', l'arrivée d'un
      // troisième rôle refusait de rétrograder un manager dès qu'il ne restait qu'un seul admin.
      `update users set role = $3
         where id = $1 and tenant_id = $2
           and ($3 = 'admin' or role <> 'admin' or disabled_at is not null
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
   * invariant que la révocation).
   *
   * ⚠️ Corrigé le 2026-07-18 : ce commentaire affirmait « aucune FK ne référence users », ce qui est FAUX
   * depuis la migration 0017 (`conversation_messages.sender_user_id`). La suppression ne viole rien parce que
   * cette FK est déclarée `on delete set null`, pas parce qu'il n'y en aurait aucune. Toute nouvelle FK vers
   * `users` doit donc déclarer explicitement son comportement de suppression, sinon ce delete se mettra à
   * échouer sur une violation de contrainte.
   *
   * 🔴 Corrigé le 2026-08-28 : `on delete set null` NE SUFFIT PAS quand la table cible porte en plus un
   * `check` sur la colonne mise à null. Le consentement d'un outil exige `actif = false or active_par is not
   * null` : le `set null` déclenché par cette suppression est une écriture ORDINAIRE, soumise au check, et il
   * fait donc échouer TOUT le `delete` en `23514`. Un départ de collaborateur rendait alors un 500, donc une
   * page Cloudflare, sur un geste parfaitement légitime. Les outils que ce compte avait mis en service sont
   * donc désactivés d'abord, dans la MÊME transaction : le consentement humain qu'ils portaient n'existe
   * plus, et un outil actif sans personne pour l'avoir autorisé est exactement ce que la contrainte interdit.
   * Ils réapparaissent inactifs dans l'onglet Outils de l'agent, où un admin les réactive.
   *
   * ⚠️ LE CONSENTEMENT A DÉMÉNAGÉ, LA PROTECTION AUSSI. Le CHECK vivait sur `agent_tools` (0086) ; il vit sur
   * `agent_tool_consommateurs` depuis 0127, et les colonnes d'origine sont parties avec 0128. Ces deux
   * écritures étaient donc à faire sur la table de liaison, et sur elle seule : les laisser sur `agent_tools`
   * aurait fait échouer tout `delete` d'utilisateur en `42703` dès l'application de 0128, c'est-à-dire sur un
   * chemin qu'aucun test unitaire ne touche et qu'on n'emprunte que le jour d'un départ.
   */
  async deleteUser(tenantId: string, userId: string): Promise<UserMutation> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      // 🔴 LE CHECK VIT SUR `agent_tool_consommateurs` (migration 0127), et il ferait échouer ce `delete`
      // exactement comme celui de `agent_tools` le faisait avant le 2026-08-28. Recopier la contrainte sans
      // recopier ce qui la protège aurait rendu ce bug à l'identique : un départ de collaborateur en 500,
      // donc une page Cloudflare, sur un geste parfaitement légitime.
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
        // Refus (dernier admin) ou compte inexistant : on ne désactive alors RIEN, sinon un refus laisserait
        // derrière lui des outils éteints sans que le compte ait bougé.
        await client.query('rollback');
        const exists = await this.pool.query(`select 1 from users where id = $1 and tenant_id = $2`, [userId, tenantId]);
        return (exists.rowCount ?? 0) > 0 ? 'last_admin' : 'not_found';
      }
      await client.query('commit');
      // ⚠️ DEUX ÉCRITURES, ET C'EST LE COMPTE COMPLET DEPUIS 0128 : le consentement ne vit plus que dans
      // `agent_tool_consommateurs`. Elles alimentent le seul journal qui relie un départ à un agent devenu
      // muet, donc en oublier une ferait sous-déclarer ce qu'on vient d'éteindre.
      const eteints = (liaisonsActives.rowCount ?? 0) + (liaisonsAutonomes.rowCount ?? 0);
      // Journalisé : un agent qui cesse d'envoyer un bloc doit pouvoir être rattaché à ce geste-là, sans
      // quoi personne ne fera jamais le lien entre un départ et un agent devenu muet.
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
