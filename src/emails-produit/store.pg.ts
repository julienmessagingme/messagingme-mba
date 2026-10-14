import type { Pool } from 'pg';
import type { CategorieCoupable, Langue, TexteEmail } from './catalogue';

/**
 * LE STORE DES E-MAILS DU PRODUIT (migration 0234). 🔴 Chaque requête qui touche le journal d'un espace porte
 * `tenant_id = $1` ; les seules exceptions sont nommées : le balayage du worker (tous les espaces, il ne rend que des
 * identifiants que le travail relit DANS leur espace), le webhook de Resend (il retrouve un envoi par l'identifiant que
 * Resend lui a donné, sous une signature vérifiée), les chiffres et réglages globaux de `/ops`, et ce qui appartient à
 * une PERSONNE (sa langue, ses désinscriptions), qui n'a pas d'espace.
 */

/** Un envoi tel que le travail de la file le relit. `membreActif` : la personne est-elle encore membre active de l'espace ? */
export interface EnvoiAFaire {
  id: string;
  tenantId: string;
  cle: string;
  statut: 'a_envoyer' | 'envoye' | 'echec' | 'ignore';
  tentatives: number;
  valeurs: Record<string, string>;
  identityId: string;
  email: string;
  langue: Langue;
  espace: string;
  membreActif: boolean;
  desinscriptions: CategorieCoupable[];
}

/** Un texte modifié dans `/ops`. */
export interface TexteModifie extends TexteEmail {
  cle: string;
  langue: Langue;
  modifiePar: string;
  modifieLe: Date;
}

/** Les chiffres du mois d'un modèle. `envoyes` compte ce que Resend a accepté ; les suivants viennent de son webhook. */
export interface ChiffresModele {
  cle: string;
  emis: number;
  envoyes: number;
  echecs: number;
  ignores: number;
  livres: number;
  ouverts: number;
  cliques: number;
  rebonds: number;
  plaintes: number;
}

/** Les événements de Resend qu'on note, et la colonne de chacun. Les autres sont ignorés. */
export const EVENEMENTS_RESEND = {
  'email.delivered': 'livre_le',
  'email.opened': 'ouvert_le',
  'email.clicked': 'clique_le',
  'email.bounced': 'rebond_le',
  'email.complained': 'plainte_le',
} as const;
export type EvenementResend = keyof typeof EVENEMENTS_RESEND;

export class PgEmailsProduitStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Les identités des administrateurs actifs de l'espace qui se sont DÉJÀ connectés (décision de Julien du
   * 2026-10-14) : une invitation pas encore acceptée ne reçoit rien.
   */
  async adminsConnectes(tenantId: string): Promise<string[]> {
    const res = await this.pool.query<{ identity_id: string }>(
      `select distinct u.identity_id from users u
        where u.tenant_id = $1 and u.role = 'admin' and u.disabled_at is null
          and u.last_login_at is not null and u.identity_id is not null`,
      [tenantId],
    );
    return res.rows.map((r) => r.identity_id);
  }

  /**
   * Réserve une ligne par personne pour cette occasion. 🔴 C'est le dédoublonnage : une occasion déjà réservée pour une
   * personne ne rend rien, quel que soit le nombre de copies qui émettent en même temps. Rend les lignes créées.
   */
  async reserver(e: { tenantId: string; cle: string; occasion: string; identites: string[]; valeurs: Record<string, string> }): Promise<string[]> {
    if (e.identites.length === 0) return [];
    const res = await this.pool.query<{ id: string }>(
      `insert into emails_produit_envois (tenant_id, cle, identity_id, occasion, variables)
       select $1, $2, i, $3, $5::jsonb from unnest($4::uuid[]) as i
       on conflict on constraint emails_produit_envois_une_par_occasion do nothing
       returning id`,
      [e.tenantId, e.cle, e.occasion, e.identites, JSON.stringify(e.valeurs)],
    );
    return res.rows.map((r) => r.id);
  }

  /** Un envoi, relu DANS son espace, avec ce que le travail doit savoir de la personne. */
  async pourEnvoi(tenantId: string, envoiId: string): Promise<EnvoiAFaire | null> {
    const res = await this.pool.query<{
      id: string; tenant_id: string; cle: string; statut: EnvoiAFaire['statut']; tentatives: number;
      variables: Record<string, unknown>; identity_id: string; email: string; langue: string; espace: string;
      membre_actif: boolean; desinscriptions: string[];
    }>(
      `select e.id, e.tenant_id, e.cle, e.statut, e.tentatives, e.variables, e.identity_id, i.email, i.langue,
              t.name as espace,
              exists (select 1 from users u where u.tenant_id = $1 and u.identity_id = e.identity_id
                         and u.disabled_at is null) as membre_actif,
              coalesce((select array_agg(d.categorie) from emails_produit_desinscriptions d
                         where d.identity_id = e.identity_id), '{}') as desinscriptions
         from emails_produit_envois e
         join identities i on i.id = e.identity_id
         join tenants t on t.id = e.tenant_id
        where e.tenant_id = $1 and e.id = $2`,
      [tenantId, envoiId],
    );
    const r = res.rows[0];
    if (!r) return null;
    const valeurs: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.variables ?? {})) if (typeof v === 'string') valeurs[k] = v;
    return {
      id: r.id, tenantId: r.tenant_id, cle: r.cle, statut: r.statut, tentatives: Number(r.tentatives), valeurs,
      identityId: r.identity_id, email: r.email, langue: r.langue === 'en' ? 'en' : 'fr', espace: r.espace ?? '',
      membreActif: r.membre_actif === true,
      desinscriptions: (r.desinscriptions ?? []).filter((c): c is CategorieCoupable => c === 'commercial' || c === 'transfert'),
    };
  }

  /**
   * Prend l'envoi pour UNE tentative : seul le travail qui porte le bon numéro de tentative le prend. Deux jobs pour la
   * même ligne (le balayage en a renfilé une déjà en file) ne l'envoient donc qu'une fois.
   * 🔴 La prise pose un BAIL de dix minutes (`prochain_essai_le`) : pendant l'appel à Resend, le balayage ne la renfile
   * pas (sans quoi un job neuf, avec le nouveau numéro, la prendrait et l'enverrait une seconde fois). Un worker tué en
   * plein envoi laisse le bail expirer, et l'envoi est repris.
   */
  async prendre(tenantId: string, envoiId: string, tentative: number): Promise<boolean> {
    const res = await this.pool.query(
      `update emails_produit_envois set tentatives = tentatives + 1, prochain_essai_le = now() + interval '10 minutes'
        where tenant_id = $1 and id = $2 and statut = 'a_envoyer' and tentatives = $3`,
      [tenantId, envoiId, tentative],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Parti chez Resend : son identifiant est gardé (le webhook s'y raccroche), les valeurs sont vidées. */
  async noterEnvoye(tenantId: string, envoiId: string, resendId: string): Promise<void> {
    await this.pool.query(
      `update emails_produit_envois
          set statut = 'envoye', envoye_le = now(), resend_id = nullif($3, ''), variables = '{}'::jsonb, raison = null
        where tenant_id = $1 and id = $2`,
      [tenantId, envoiId, resendId],
    );
  }

  /** Un échec. `reessayerLe` : l'envoi reste à faire et le balayage le reprendra à cette heure ; `null` = définitif. */
  async noterEchec(tenantId: string, envoiId: string, raison: string, reessayerLe: Date | null): Promise<void> {
    await this.pool.query(
      `update emails_produit_envois
          set statut = case when $4::timestamptz is null then 'echec' else 'a_envoyer' end,
              prochain_essai_le = $4::timestamptz,
              raison = left($3, 300),
              variables = case when $4::timestamptz is null then '{}'::jsonb else variables end
        where tenant_id = $1 and id = $2`,
      [tenantId, envoiId, raison, reessayerLe],
    );
  }

  /** Rien n'est parti, volontairement (modèle coupé, personne désinscrite, plus membre, Resend absent). */
  async noterIgnore(tenantId: string, envoiId: string, raison: string): Promise<void> {
    await this.pool.query(
      `update emails_produit_envois set statut = 'ignore', raison = $3, variables = '{}'::jsonb
        where tenant_id = $1 and id = $2 and statut = 'a_envoyer'`,
      [tenantId, envoiId, raison],
    );
  }

  /**
   * Les envois à (re)mettre en file, tous espaces confondus : jamais enfilés (plus de cinq minutes après leur
   * création), ou dont l'heure du prochain essai est passée. 🔴 Le `where` commence par le prédicat exact de l'index
   * partiel `emails_produit_envois_a_envoyer_idx`.
   */
  async aReprendre(limite: number): Promise<Array<{ id: string; tenantId: string; tentatives: number }>> {
    const res = await this.pool.query<{ id: string; tenant_id: string; tentatives: number }>(
      `select id, tenant_id, tentatives from emails_produit_envois
        where statut = 'a_envoyer' and cree_le < now() - interval '5 minutes'
          and (prochain_essai_le is null or prochain_essai_le <= now())
        order by cree_le
        limit $1`,
      [limite],
    );
    return res.rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, tentatives: Number(r.tentatives) }));
  }

  /**
   * Note un événement de Resend sur l'envoi qu'il désigne (la première fois seulement : une deuxième ouverture ne
   * déplace pas la date). Rend l'identité de la personne, `null` si l'envoi est inconnu (d'une autre instance, ou
   * effacé par la rétention).
   */
  async noterEvenementResend(resendId: string, evenement: EvenementResend, le: Date): Promise<{ identityId: string } | null> {
    const colonne = EVENEMENTS_RESEND[evenement];
    const res = await this.pool.query<{ identity_id: string }>(
      `update emails_produit_envois set ${colonne} = coalesce(${colonne}, $2::timestamptz)
        where resend_id = $1
        returning identity_id`,
      [resendId, le],
    );
    const r = res.rows[0];
    return r ? { identityId: r.identity_id } : null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // La personne : sa langue et ses désinscriptions (pas d'espace : une adresse vaut pour tous ses espaces).
  // ---------------------------------------------------------------------------------------------------------------

  async desinscrire(identityId: string, categorie: CategorieCoupable): Promise<void> {
    await this.pool.query(
      `insert into emails_produit_desinscriptions (identity_id, categorie) values ($1, $2) on conflict do nothing`,
      [identityId, categorie],
    );
  }

  async reabonner(identityId: string, categorie: CategorieCoupable): Promise<void> {
    await this.pool.query(
      `delete from emails_produit_desinscriptions where identity_id = $1 and categorie = $2`,
      [identityId, categorie],
    );
  }

  /** La langue et les désinscriptions d'une personne, `null` si l'identité n'existe pas. */
  async preferences(identityId: string): Promise<{ langue: Langue; desinscriptions: CategorieCoupable[] } | null> {
    const res = await this.pool.query<{ langue: string; desinscriptions: string[] }>(
      `select i.langue,
              coalesce((select array_agg(d.categorie) from emails_produit_desinscriptions d where d.identity_id = i.id), '{}')
                as desinscriptions
         from identities i where i.id = $1`,
      [identityId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      langue: r.langue === 'en' ? 'en' : 'fr',
      desinscriptions: (r.desinscriptions ?? []).filter((c): c is CategorieCoupable => c === 'commercial' || c === 'transfert'),
    };
  }

  async poserLangue(identityId: string, langue: Langue): Promise<void> {
    await this.pool.query(`update identities set langue = $2 where id = $1 and langue <> $2`, [identityId, langue]);
  }

  /** L'identité d'un compte (la session porte le compte, la préférence est à la personne). */
  async identiteDuCompte(tenantId: string, userId: string): Promise<string | null> {
    const res = await this.pool.query<{ identity_id: string | null }>(
      `select identity_id from users where tenant_id = $1 and id = $2`,
      [tenantId, userId],
    );
    return res.rows[0]?.identity_id ?? null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // /ops : les réglages globaux et les chiffres du mois (tous espaces confondus, par construction).
  // ---------------------------------------------------------------------------------------------------------------

  async textesModifies(): Promise<TexteModifie[]> {
    const res = await this.pool.query<{
      cle: string; langue: string; sujet: string; corps: string; bouton_libelle: string | null; bouton_lien: string | null;
      modifie_par: string; modifie_le: Date;
    }>(`select cle, langue, sujet, corps, bouton_libelle, bouton_lien, modifie_par, modifie_le from emails_produit_textes`);
    return res.rows.map((r) => ({
      cle: r.cle, langue: r.langue === 'en' ? 'en' : 'fr', sujet: r.sujet, corps: r.corps,
      bouton: r.bouton_libelle !== null && r.bouton_lien !== null ? { libelle: r.bouton_libelle, lien: r.bouton_lien } : null,
      modifiePar: r.modifie_par, modifieLe: r.modifie_le,
    }));
  }

  /** Le texte modifié d'un modèle dans une langue, `null` = le texte d'origine. */
  async texteModifie(cle: string, langue: Langue): Promise<TexteEmail | null> {
    const res = await this.pool.query<{ sujet: string; corps: string; bouton_libelle: string | null; bouton_lien: string | null }>(
      `select sujet, corps, bouton_libelle, bouton_lien from emails_produit_textes where cle = $1 and langue = $2`,
      [cle, langue],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      sujet: r.sujet, corps: r.corps,
      bouton: r.bouton_libelle !== null && r.bouton_lien !== null ? { libelle: r.bouton_libelle, lien: r.bouton_lien } : null,
    };
  }

  async ecrireTexte(cle: string, langue: Langue, t: TexteEmail, par: string): Promise<void> {
    await this.pool.query(
      `insert into emails_produit_textes (cle, langue, sujet, corps, bouton_libelle, bouton_lien, modifie_par)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (cle, langue) do update set sujet = excluded.sujet, corps = excluded.corps,
         bouton_libelle = excluded.bouton_libelle, bouton_lien = excluded.bouton_lien,
         modifie_par = excluded.modifie_par, modifie_le = now()`,
      [cle, langue, t.sujet, t.corps, t.bouton?.libelle ?? null, t.bouton?.lien ?? null, par],
    );
  }

  /** Rétablit le texte d'origine. Rend `true` si un texte modifié existait. */
  async retablir(cle: string, langue: Langue): Promise<boolean> {
    const res = await this.pool.query(`delete from emails_produit_textes where cle = $1 and langue = $2`, [cle, langue]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Les modèles coupés ou rallumés dans `/ops`. Absent = actif. */
  async interrupteurs(): Promise<Map<string, { actif: boolean; modifiePar: string; modifieLe: Date }>> {
    const res = await this.pool.query<{ cle: string; actif: boolean; modifie_par: string; modifie_le: Date }>(
      `select cle, actif, modifie_par, modifie_le from emails_produit_interrupteurs`,
    );
    return new Map(res.rows.map((r) => [r.cle, { actif: r.actif, modifiePar: r.modifie_par, modifieLe: r.modifie_le }]));
  }

  async actif(cle: string): Promise<boolean> {
    const res = await this.pool.query<{ actif: boolean }>(`select actif from emails_produit_interrupteurs where cle = $1`, [cle]);
    return res.rows[0]?.actif ?? true;
  }

  async poserInterrupteur(cle: string, actif: boolean, par: string): Promise<void> {
    await this.pool.query(
      `insert into emails_produit_interrupteurs (cle, actif, modifie_par) values ($1, $2, $3)
       on conflict (cle) do update set actif = excluded.actif, modifie_par = excluded.modifie_par, modifie_le = now()`,
      [cle, actif, par],
    );
  }

  /** Les chiffres du mois civil de Paris, par modèle : ce qui a été émis ce mois-ci, et ce qu'il est devenu. */
  async chiffresDuMois(): Promise<ChiffresModele[]> {
    const res = await this.pool.query<{
      cle: string; emis: number; envoyes: number; echecs: number; ignores: number; livres: number; ouverts: number;
      cliques: number; rebonds: number; plaintes: number;
    }>(
      `select cle, count(*)::int as emis,
              count(*) filter (where envoye_le is not null)::int as envoyes,
              count(*) filter (where statut = 'echec')::int as echecs,
              count(*) filter (where statut = 'ignore')::int as ignores,
              count(*) filter (where livre_le is not null)::int as livres,
              count(*) filter (where ouvert_le is not null)::int as ouverts,
              count(*) filter (where clique_le is not null)::int as cliques,
              count(*) filter (where rebond_le is not null)::int as rebonds,
              count(*) filter (where plainte_le is not null)::int as plaintes
         from emails_produit_envois
        where cree_le >= date_trunc('month', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris'
        group by cle`,
    );
    return res.rows.map((r) => ({
      cle: r.cle, emis: r.emis, envoyes: r.envoyes, echecs: r.echecs, ignores: r.ignores, livres: r.livres,
      ouverts: r.ouverts, cliques: r.cliques, rebonds: r.rebonds, plaintes: r.plaintes,
    }));
  }

  /** La rétention du journal : treize mois (les chiffres d'un mois se comparent à ceux de l'an passé). Par paquets. */
  async purgerAnciens(paquet = 5000): Promise<number> {
    const res = await this.pool.query(
      `delete from emails_produit_envois where id in (
         select id from emails_produit_envois where cree_le < now() - interval '13 months' limit $1)`,
      [paquet],
    );
    return res.rowCount ?? 0;
  }
}
