import type { Pool } from 'pg';
import { DUREE_CODE_S } from './jetons';
import type { HorsOffreMembre } from '../offres/membres';

/**
 * Les autorisations OAuth et leurs codes (migration 0204).
 *
 * 🔴 `tenant_id = $1` SUR CHAQUE REQUÊTE D'UN ESPACE (`lister`, `revoquer`) : le pooler contourne la RLS, ce filtre
 * est le seul contrôle d'isolation. Les autres requêtes partent d'une EMPREINTE (jeton, code) : comme `parCode` des
 * widgets, c'est l'empreinte qui désigne la ligne, et la ligne qui rend l'espace.
 * 🔴 Seules des empreintes entrent et sortent d'ici : jamais un jeton, un code ni un vérificateur PKCE.
 */

/** Ce que la garde de `/mcp` lit d'un jeton d'accès, en une requête. */
export interface AccesOauth {
  autorisationId: string;
  tenantId: string;
  userId: string;
  scopes: string[];
  tenantStatus: string;
  /**
   * Faux si l'autorisation est révoquée, son jeton d'accès échu, le compte désactivé ou plus admin. Le rôle est
   * relu ici à chaque appel, jamais figé dans le jeton : un admin rétrogradé perd l'accès à l'appel suivant.
   */
  valide: boolean;
}

/**
 * Un accès résolu, avec le gel des membres (lot 6, B2a) : `horsOffre` dit si la personne du jeton dépasse les limites de
 * l'offre de son espace. Le magasin ne le sait pas (il faut l'offre) : l'API l'enveloppe (`src/index.ts`), et le
 * compilateur refuse de monter la garde sur le magasin seul.
 */
export type AccesOauthResolu = AccesOauth & { horsOffre: HorsOffreMembre | null };

/** L'interface étroite de la garde (`makeRequireApiKey`), comme `ApiKeyLookup` pour les clés. */
export interface AccesOauthLookup {
  resoudreAcces(empreinte: string): Promise<AccesOauthResolu | null>;
}

export interface NouvelleAutorisation {
  tenantId: string;
  userId: string;
  clientId: string;
  scopes: readonly string[];
  resource: string;
  code: { empreinte: string; challenge: string; redirectUri: string };
}

export interface CodeConsomme {
  autorisationId: string;
  tenantId: string;
  clientId: string;
  challenge: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
}

/** Les empreintes d'une paire de jetons neuve, et leurs échéances. */
export interface NouveauxJetons {
  acces: string;
  refresh: string;
  accesExpireLe: Date;
  refreshExpireLe: Date;
}

/** Une ligne de « Applications autorisées » : ni empreinte, ni échéance de jeton. */
export interface AutorisationListee {
  id: string;
  clientId: string;
  userId: string;
  email: string;
  nom: string | null;
  scopes: string[];
  creeLe: string;
  dernierUsageLe: string | null;
}

/** La purge efface par paquets : une rafale de lignes mortes ne tient jamais un verrou long. */
const PAQUET_PURGE = 1000;

/**
 * Une autorisation morte : révoquée, ou dont le renouvellement est échu (30 jours sans usage ou 90 jours au plus),
 * ou dont le code n'a jamais été échangé (`cree_le`). `least` ignore un nul : sans jetons, on retombe sur `cree_le`.
 */
const FIN_DE_VIE = `coalesce(revoque_le, least(refresh_expire_le, refresh_max_le), cree_le)`;

export class PgOauthStore {
  constructor(private readonly pool: Pool) {}

  /** L'autorisation et son code, ensemble ou pas du tout : un code sans autorisation, ou l'inverse, ne sert à rien. */
  async creerAutorisation(e: NouvelleAutorisation): Promise<{ autorisationId: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const res = await client.query<{ id: string }>(
        `insert into oauth_autorisations (tenant_id, user_id, client_id, scopes, resource)
         values ($1, $2, $3, $4, $5) returning id`,
        [e.tenantId, e.userId, e.clientId, e.scopes, e.resource],
      );
      const autorisationId = res.rows[0]!.id;
      await client.query(
        `insert into oauth_codes (hash, autorisation_id, code_challenge, redirect_uri, expire_le)
         values ($1, $2, $3, $4, now() + make_interval(secs => $5::float8))`,
        [e.code.empreinte, autorisationId, e.code.challenge, e.code.redirectUri, DUREE_CODE_S],
      );
      await client.query('commit');
      return { autorisationId };
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Consomme un code : une seule fois, même en concurrence (l'`update` conditionnel ne fait gagner qu'un des
   * deux), et seulement avant son échéance. Le code est brûlé même si l'échange échoue ensuite (PKCE faux) : un
   * vérificateur ne se devine pas en plusieurs essais. `null` aussi pour une autorisation déjà révoquée.
   */
  async consommerCode(empreinte: string): Promise<CodeConsomme | null> {
    const res = await this.pool.query<{
      autorisation_id: string; tenant_id: string; client_id: string; code_challenge: string; redirect_uri: string;
      scopes: string[]; resource: string;
    }>(
      `with c as (
         update oauth_codes set utilise_le = now()
          where hash = $1 and utilise_le is null and expire_le > now()
         returning autorisation_id, code_challenge, redirect_uri
       )
       select c.autorisation_id, a.tenant_id, a.client_id, c.code_challenge, c.redirect_uri, a.scopes, a.resource
         from c join oauth_autorisations a on a.id = c.autorisation_id
        where a.revoque_le is null`,
      [empreinte],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      autorisationId: r.autorisation_id, tenantId: r.tenant_id, clientId: r.client_id, challenge: r.code_challenge,
      redirectUri: r.redirect_uri, scopes: r.scopes, resource: r.resource,
    };
  }

  /**
   * Pose la première paire de jetons d'une autorisation, au premier échange de son code. `false` si elle en porte
   * déjà une ou si elle a été révoquée entre-temps. `refreshMaxLe` est fixé ici, une fois : le renouvellement ne le
   * repousse jamais.
   */
  async poserJetons(autorisationId: string, j: NouveauxJetons & { refreshMaxLe: Date }): Promise<boolean> {
    const res = await this.pool.query(
      `update oauth_autorisations
          set acces_hash = $2, acces_expire_le = $3, refresh_hash = $4,
              refresh_expire_le = least($5::timestamptz, $6::timestamptz), refresh_max_le = $6
        where id = $1 and revoque_le is null and refresh_hash is null`,
      [autorisationId, j.acces, j.accesExpireLe, j.refresh, j.refreshExpireLe, j.refreshMaxLe],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Renouvelle : le jeton présenté passe en `refresh_precedent_hash`, une paire neuve prend sa place.
   *
   * 🔴 UN ANCIEN JETON PRÉSENTÉ RÉVOQUE TOUTE L'AUTORISATION (RFC 9700, 4.14) et rend `rejeu` : c'est le signe qu'il
   * a fui. Deux renouvellements simultanés du même jeton y mènent aussi : le second attend le verrou de ligne du
   * premier, ne retrouve plus son empreinte en cours, et la trouve en précédente. Accepté par la spec.
   *
   * Refusé (`inconnu`) : un jeton inconnu, échu, d'un autre client, ou dont la personne n'est plus admin ou est
   * désactivée. Un espace suspendu n'est PAS refusé ici : `/mcp` lui rend 403, et refuser le renouvellement
   * relancerait la connexion en boucle.
   */
  async renouveler(empreinteRefresh: string, clientId: string, nouveaux: NouveauxJetons): Promise<'ok' | 'rejeu' | 'inconnu'> {
    const tourne = await this.pool.query(
      `update oauth_autorisations a
          set refresh_precedent_hash = a.refresh_hash, refresh_hash = $3,
              acces_hash = $4, acces_expire_le = $5, refresh_expire_le = least($6::timestamptz, a.refresh_max_le),
              dernier_usage_le = now()
         from users u
        where a.refresh_hash = $1 and a.client_id = $2 and a.revoque_le is null
          and a.refresh_expire_le > now() and a.refresh_max_le > now()
          and u.id = a.user_id and u.tenant_id = a.tenant_id and u.role = 'admin' and u.disabled_at is null`,
      [empreinteRefresh, clientId, nouveaux.refresh, nouveaux.acces, nouveaux.accesExpireLe, nouveaux.refreshExpireLe],
    );
    if ((tourne.rowCount ?? 0) > 0) return 'ok';
    const rejeu = await this.pool.query(
      `update oauth_autorisations set revoque_le = coalesce(revoque_le, now())
        where refresh_precedent_hash = $1`,
      [empreinteRefresh],
    );
    return (rejeu.rowCount ?? 0) > 0 ? 'rejeu' : 'inconnu';
  }

  /**
   * Le jeton d'accès, sa personne et son espace, en une requête : la garde la fait à chaque appel. Le dernier usage
   * s'écrit dans la même requête, au plus une fois par minute, et seulement pour un accès valide.
   */
  async resoudreAcces(empreinte: string): Promise<AccesOauth | null> {
    const res = await this.pool.query<{
      id: string; tenant_id: string; user_id: string; scopes: string[]; tenant_status: string; valide: boolean;
    }>(
      `with a as (
         select a.id, a.tenant_id, a.user_id, a.scopes, t.status as tenant_status, a.dernier_usage_le,
                coalesce(a.revoque_le is null and a.acces_expire_le > now()
                         and u.disabled_at is null and u.role = 'admin', false) as valide
           from oauth_autorisations a
           join users u on u.id = a.user_id and u.tenant_id = a.tenant_id
           join tenants t on t.id = a.tenant_id
          where a.acces_hash = $1
       ), touche as (
         update oauth_autorisations o set dernier_usage_le = now()
           from a
          where o.id = a.id and a.valide
            and (a.dernier_usage_le is null or a.dernier_usage_le < now() - interval '1 minute')
       )
       select id, tenant_id, user_id, scopes, tenant_status, valide from a`,
      [empreinte],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      autorisationId: r.id, tenantId: r.tenant_id, userId: r.user_id, scopes: r.scopes, tenantStatus: r.tenant_status,
      valide: r.valide,
    };
  }

  /**
   * La révocation par le client (RFC 7009) : son jeton d'accès ou de renouvellement révoque toute l'autorisation.
   * `false` pour un jeton inconnu ou déjà révoqué ; la route rend 200 dans les deux cas.
   */
  async revoquerParJeton(empreinte: string): Promise<boolean> {
    const res = await this.pool.query(
      `update oauth_autorisations set revoque_le = now()
        where (acces_hash = $1 or refresh_hash = $1) and revoque_le is null`,
      [empreinte],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Les autorisations vivantes de l'espace, la plus récente d'abord : non révoquées, avec un renouvellement encore
   * valide. Celles dont le code n'a jamais été échangé ne servent à rien et n'y figurent pas.
   */
  async lister(tenantId: string): Promise<AutorisationListee[]> {
    const res = await this.pool.query<{
      id: string; client_id: string; user_id: string; email: string; name: string | null; scopes: string[];
      cree_le: Date; dernier_usage_le: Date | null;
    }>(
      `select a.id, a.client_id, a.user_id, u.email, u.name, a.scopes, a.cree_le, a.dernier_usage_le
         from oauth_autorisations a join users u on u.id = a.user_id and u.tenant_id = a.tenant_id
        where a.tenant_id = $1 and a.revoque_le is null and a.refresh_hash is not null
          and least(a.refresh_expire_le, a.refresh_max_le) > now()
        order by a.cree_le desc`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id, clientId: r.client_id, userId: r.user_id, email: r.email, nom: r.name, scopes: r.scopes,
      creeLe: r.cree_le.toISOString(), dernierUsageLe: r.dernier_usage_le ? r.dernier_usage_le.toISOString() : null,
    }));
  }

  /** Révoque une autorisation de l'espace. `false` si elle est inconnue, d'un autre espace, ou déjà révoquée. */
  async revoquer(tenantId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      `update oauth_autorisations set revoque_le = now()
        where id = $1 and tenant_id = $2 and revoque_le is null`,
      [id, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * La purge (worker) : les codes échus depuis une heure, et les autorisations mortes depuis 30 jours (leurs codes
   * partent avec elles, en cascade). Rend le nombre de lignes effacées.
   */
  async purger(): Promise<number> {
    const requetes = [
      `delete from oauth_codes where hash in (
         select hash from oauth_codes where expire_le < now() - interval '1 hour' limit $1)`,
      `delete from oauth_autorisations where id in (
         select id from oauth_autorisations where ${FIN_DE_VIE} < now() - interval '30 days' limit $1)`,
    ];
    let total = 0;
    for (const sql of requetes) {
      for (;;) {
        const n = (await this.pool.query(sql, [PAQUET_PURGE])).rowCount ?? 0;
        total += n;
        if (n < PAQUET_PURGE) break;
      }
    }
    return total;
  }
}
