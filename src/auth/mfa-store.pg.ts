import type { Pool, PoolClient } from 'pg';
import { enTransaction } from '../db/transaction';
import { encryptSecret, decryptSecret } from '../crypto/secretbox';
import { estUuid } from '../http/scope';

/**
 * Le second facteur d'une identité. 🔴 Il vit sur `identities`, pas sur `users` : c'est la personne qui a un
 * téléphone, pas chacun de ses comptes. Les méthodes prennent une identité, sauf celles qui partent du seul
 * compte que l'appelant a en main. Les secrets entrent et sortent en clair : le chiffrement
 * (`ENCRYPTION_KEY`) est une affaire de stockage, les routes ne manipulent pas de textes chiffrés.
 */
export interface EtatMfa {
  identityId: string;
  email: string;
  /** Le secret actif, en base32. `null` = aucun facteur actif. */
  secret: string | null;
  activeLe: Date | null;
  /** Le dernier pas TOTP accepté (anti-rejeu). */
  dernierPas: number | null;
  /** Le secret d'un enrôlement en cours, en base32. */
  secretEnAttente: string | null;
  codesSecoursRestants: number;
  /** L'identité a-t-elle un compte `admin` actif quelque part ? C'est ce qui rend le facteur obligatoire. */
  obligatoire: boolean;
  /** Fin du blocage du code de l'application après une série d'échecs ; les codes de secours restent acceptés. */
  bloqueJusqua: Date | null;
}

/** `autres_espaces` : l'identité a un compte dans un autre espace, un admin d'ici n'a pas à y toucher. */
export type IssueReinitialisation = 'ok' | 'not_found' | 'autres_espaces';

export interface MfaStore {
  lire(identityId: string): Promise<EtatMfa | null>;
  /** L'état de l'identité d'un compte. `null` = compte inconnu, ou sans identité. */
  lireParCompte(userId: string): Promise<EtatMfa | null>;
  /** Pose (écrase) le secret d'un enrôlement en cours. Ne touche pas un facteur actif. */
  poserSecretEnAttente(identityId: string, secret: string): Promise<void>;
  /**
   * Active `secret` (dont le premier code vient d'être vérifié), retient son pas et remplace les codes de
   * secours, en une transaction. 🔴 `false` si un facteur était déjà actif : un enrôlement ne remplace jamais
   * un facteur actif, sinon le jeton d'enrôlement servirait à le contourner.
   */
  activer(identityId: string, secret: string, pas: number, empreintesCodes: string[]): Promise<boolean>;
  /** Retient le pas accepté s'il est plus récent que le dernier. `false` = rejeu (ou course perdue). */
  marquerPas(identityId: string, pas: number): Promise<boolean>;
  /** Consomme un code de secours. `true` une seule fois par code, même sous deux présentations simultanées. */
  consommerCodeSecours(identityId: string, empreinte: string): Promise<boolean>;
  /** Remplace les codes de secours d'un facteur actif. `false` si aucun facteur n'est actif. */
  remplacerCodesSecours(identityId: string, empreintesCodes: string[]): Promise<boolean>;
  /** Retire le facteur et les codes. */
  desactiver(identityId: string): Promise<void>;
  /** Réinitialisation par un admin de l'espace : refusée si l'identité a un compte ailleurs. */
  reinitialiserDansEspace(tenantId: string, userId: string): Promise<IssueReinitialisation>;
  /** Réinitialisation d'exploitation, par l'adresse. Rend l'identité, ou `null` si l'adresse est inconnue. */
  reinitialiserParEmail(email: string): Promise<string | null>;
  /** Les comptes d'une identité, tout statut : le journal s'écrit dans chacun de ses espaces. */
  comptes(identityId: string): Promise<Array<{ userId: string; tenantId: string; email: string }>>;
  /**
   * Compte un échec. Chaque série de 5 échecs consécutifs bloque le code de l'application pour une durée qui
   * double (15 min, 30 min, ... 24 h au plus). Rend la fin du blocage en cours, ou `null`.
   */
  noterEchec(identityId: string): Promise<Date | null>;
  /** Un code juste remet le compteur à zéro. */
  noterReussite(identityId: string): Promise<void>;
  /** Le hash du mot de passe de l'identité, `null` si elle n'en a pas (compte Google, invitation en attente). */
  motDePasse(identityId: string): Promise<string | null>;
}

interface LigneEtat {
  id: string;
  email: string;
  mfa_secret_enc: string | null;
  mfa_active_le: Date | null;
  mfa_dernier_pas: string | null;
  mfa_secret_attente_enc: string | null;
  codes_restants: number;
  obligatoire: boolean;
  mfa_bloque_jusqua: Date | null;
}

const SELECT_ETAT = `
  select i.id, i.email, i.mfa_secret_enc, i.mfa_active_le, i.mfa_dernier_pas, i.mfa_secret_attente_enc, i.mfa_bloque_jusqua,
         (select count(*) from mfa_codes_secours c where c.identity_id = i.id and c.utilise_le is null)::int as codes_restants,
         exists (select 1 from users a where a.identity_id = i.id and a.role = 'admin' and a.disabled_at is null) as obligatoire
    from identities i`;

export class PgMfaStore implements MfaStore {
  constructor(private readonly pool: Pool, private readonly cle: string) {}

  private etat(r: LigneEtat | undefined): EtatMfa | null {
    if (!r) return null;
    return {
      identityId: r.id,
      email: r.email,
      // Un facteur n'est actif que si la date d'activation est posée : un secret sans elle serait un reste.
      secret: r.mfa_active_le !== null && r.mfa_secret_enc !== null ? decryptSecret(r.mfa_secret_enc, this.cle) : null,
      activeLe: r.mfa_active_le,
      // `bigint` revient en texte de `pg` : le nombre de pas depuis 1970 tient largement dans un double.
      dernierPas: r.mfa_dernier_pas === null ? null : Number(r.mfa_dernier_pas),
      secretEnAttente: r.mfa_secret_attente_enc === null ? null : decryptSecret(r.mfa_secret_attente_enc, this.cle),
      codesSecoursRestants: r.codes_restants,
      obligatoire: r.obligatoire,
      bloqueJusqua: r.mfa_bloque_jusqua,
    };
  }

  async lire(identityId: string): Promise<EtatMfa | null> {
    // Un identifiant mal formé partirait dans un `where id = $1` sur une colonne `uuid` : 22P02, donc un 500.
    if (!estUuid(identityId)) return null;
    const res = await this.pool.query<LigneEtat>(`${SELECT_ETAT} where i.id = $1`, [identityId]);
    return this.etat(res.rows[0]);
  }

  async lireParCompte(userId: string): Promise<EtatMfa | null> {
    if (!estUuid(userId)) return null;
    const res = await this.pool.query<LigneEtat>(
      `${SELECT_ETAT} join users u on u.identity_id = i.id where u.id = $1`,
      [userId],
    );
    return this.etat(res.rows[0]);
  }

  async poserSecretEnAttente(identityId: string, secret: string): Promise<void> {
    await this.pool.query(
      `update identities set mfa_secret_attente_enc = $2 where id = $1`,
      [identityId, encryptSecret(secret, this.cle)],
    );
  }

  async activer(identityId: string, secret: string, pas: number, empreintesCodes: string[]): Promise<boolean> {
    return enTransaction(this.pool, async (client) => {
      const res = await client.query(
        `update identities
            set mfa_secret_enc = $2, mfa_active_le = now(), mfa_dernier_pas = $3, mfa_secret_attente_enc = null
          where id = $1 and mfa_active_le is null`,
        [identityId, encryptSecret(secret, this.cle), pas],
      );
      if ((res.rowCount ?? 0) === 0) return false;
      await this.poserCodes(client, identityId, empreintesCodes);
      return true;
    });
  }

  async marquerPas(identityId: string, pas: number): Promise<boolean> {
    // La condition est dans le `where` : deux présentations simultanées du même code lisent le même
    // `dernierPas`, passent la vérification en mémoire, et une seule écrit ici.
    const res = await this.pool.query(
      `update identities set mfa_dernier_pas = $2
        where id = $1 and mfa_active_le is not null and (mfa_dernier_pas is null or mfa_dernier_pas < $2)`,
      [identityId, pas],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async consommerCodeSecours(identityId: string, empreinte: string): Promise<boolean> {
    // Une requête conditionnelle : c'est elle qui garantit qu'un code ne sert qu'une fois (voir `genererCodesSecours`).
    const res = await this.pool.query(
      `update mfa_codes_secours set utilise_le = now()
        where identity_id = $1 and code_hash = $2 and utilise_le is null
        returning identity_id`,
      [identityId, empreinte],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async remplacerCodesSecours(identityId: string, empreintesCodes: string[]): Promise<boolean> {
    return enTransaction(this.pool, async (client) => {
      const actif = await client.query(
        `select 1 from identities where id = $1 and mfa_active_le is not null for update`,
        [identityId],
      );
      if ((actif.rowCount ?? 0) === 0) return false;
      await this.poserCodes(client, identityId, empreintesCodes);
      return true;
    });
  }

  async desactiver(identityId: string): Promise<void> {
    await enTransaction(this.pool, (client) => this.effacer(client, identityId));
  }

  async reinitialiserDansEspace(tenantId: string, userId: string): Promise<IssueReinitialisation> {
    if (!estUuid(userId)) return 'not_found';
    return enTransaction(this.pool, async (client) => {
      const res = await client.query<{ identity_id: string | null; ailleurs: boolean }>(
        `select u.identity_id,
                exists (select 1 from users o where o.identity_id = u.identity_id and o.tenant_id <> u.tenant_id) as ailleurs
           from users u
          where u.id = $1 and u.tenant_id = $2`,
        [userId, tenantId],
      );
      const r = res.rows[0];
      if (!r || r.identity_id === null) return 'not_found';
      if (r.ailleurs) return 'autres_espaces';
      await this.effacer(client, r.identity_id);
      return 'ok';
    });
  }

  async reinitialiserParEmail(email: string): Promise<string | null> {
    return enTransaction(this.pool, async (client) => {
      const res = await client.query<{ id: string }>(`select id from identities where lower(email) = lower($1)`, [email]);
      const id = res.rows[0]?.id;
      if (!id) return null;
      await this.effacer(client, id);
      return id;
    });
  }

  async comptes(identityId: string): Promise<Array<{ userId: string; tenantId: string; email: string }>> {
    if (!estUuid(identityId)) return [];
    const res = await this.pool.query<{ id: string; tenant_id: string; email: string }>(
      `select id, tenant_id, email from users where identity_id = $1 order by tenant_id, id`,
      [identityId],
    );
    return res.rows.map((r) => ({ userId: r.id, tenantId: r.tenant_id, email: r.email }));
  }

  async noterEchec(identityId: string): Promise<Date | null> {
    // Un seul `update` : deux échecs simultanés ne peuvent pas lire le même compteur et en perdre un.
    const res = await this.pool.query<{ bloque: Date | null }>(
      `update identities
          set mfa_echecs = mfa_echecs + 1,
              mfa_bloque_jusqua = case when (mfa_echecs + 1) % 5 = 0
                then now() + least(interval '24 hours', interval '15 minutes' * power(2, (mfa_echecs + 1) / 5 - 1))
                else mfa_bloque_jusqua end
        where id = $1
        returning case when mfa_bloque_jusqua > now() then mfa_bloque_jusqua end as bloque`,
      [identityId],
    );
    return res.rows[0]?.bloque ?? null;
  }

  async noterReussite(identityId: string): Promise<void> {
    await this.pool.query(
      `update identities set mfa_echecs = 0, mfa_bloque_jusqua = null
        where id = $1 and (mfa_echecs <> 0 or mfa_bloque_jusqua is not null)`,
      [identityId],
    );
  }

  async motDePasse(identityId: string): Promise<string | null> {
    if (!estUuid(identityId)) return null;
    const res = await this.pool.query<{ password_hash: string | null }>(`select password_hash from identities where id = $1`, [identityId]);
    return res.rows[0]?.password_hash ?? null;
  }

  /** Remplace les codes : les anciens partent, les dix neufs arrivent, dans la transaction de l'appelant. */
  private async poserCodes(client: PoolClient, identityId: string, empreintes: string[]): Promise<void> {
    await client.query(`delete from mfa_codes_secours where identity_id = $1`, [identityId]);
    await client.query(
      `insert into mfa_codes_secours (identity_id, code_hash) select $1, unnest($2::text[])`,
      [identityId, empreintes],
    );
  }

  /** Retire tout : secret actif, secret en attente, pas, codes. Les sessions déjà émises vivent jusqu'à leur fin. */
  private async effacer(client: PoolClient, identityId: string): Promise<void> {
    await client.query(
      `update identities
          set mfa_secret_enc = null, mfa_active_le = null, mfa_dernier_pas = null, mfa_secret_attente_enc = null,
              mfa_echecs = 0, mfa_bloque_jusqua = null
        where id = $1`,
      [identityId],
    );
    await client.query(`delete from mfa_codes_secours where identity_id = $1`, [identityId]);
  }
}
