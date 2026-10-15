import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { MimeFichier } from '../medias/fichier';
import { enTransaction } from '../db/transaction';
import { LimiteOffreError } from '../offres/refus';

/** Un visuel, sans ses octets : ce que le téléversement rend. */
export interface RcsMediaResume {
  id: string;
  code: string;
  mime: MimeFichier;
  taille: number;
  nom: string | null;
  createdAt: string;
}

/** Un visuel servi : les octets et leur type réel (celui déduit à l'écriture, jamais un type déclaré). */
export interface RcsMediaFichier {
  bytes: Buffer;
  mime: MimeFichier;
}

/**
 * Ce qui cite encore un fichier et pourrait l'envoyer (spec médias du 2026-10-14, § 2.4). 🔴 La liste des lieux dérive
 * dès qu'un écran neuf se met à téléverser : `tests/medias-lieux.test.ts` exige que chaque écran qui utilise
 * `ChampImageHebergee` soit rattaché à l'un d'eux.
 */
export const LIEUX_UTILISATION = ['scenario', 'message_rcs', 'campagne', 'brouillon_campagne'] as const;
export type LieuUtilisation = (typeof LIEUX_UTILISATION)[number];
export interface UtilisationMedia {
  lieu: LieuUtilisation;
  nom: string;
}

export type IssueSuppression = { issue: 'supprime' } | { issue: 'introuvable' } | { issue: 'utilise'; utilisations: UtilisationMedia[] };

/**
 * Un fichier supprimé reste servi ce nombre de jours : un visuel déjà parti en RCS peut être téléchargé tard par
 * l'opérateur, et une adresse `/m/` distribuée est une porte à sens unique. La purge du worker l'efface au-delà.
 */
export const GRACE_SUPPRESSION_JOURS = 30;

/** Le fichier vivant, ou supprimé depuis moins de la grâce : ce que `/m/` sert encore. */
const SERVI = `(supprime_le is null or supprime_le > now() - make_interval(days => ${GRACE_SUPPRESSION_JOURS}))`;

type Ligne = { id: string; code: string; mime: MimeFichier; taille: number; nom: string | null; created_at: Date };
const resume = (r: Ligne): RcsMediaResume => ({ id: r.id, code: r.code, mime: r.mime, taille: r.taille, nom: r.nom, createdAt: r.created_at.toISOString() });

/**
 * La médiathèque d'un espace (`rcs_media`, nom historique : WhatsApp s'en sert aussi). 🔴 L'opérateur télécom va chercher
 * l'image sur une URL publique, sans session : `getByCode` ne prend pas d'espace, c'est le code (130 bits) qui tient
 * l'accès. Toutes les autres opérations sont scopées espace.
 */
export class PgRcsMediaStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Dépose un fichier déjà validé (signature lue, poids borné). Sous verrou d'espace, pour que deux dépôts simultanés ne
   * dépassent pas le quota : un fichier identique (même empreinte) déjà vivant rend sa fiche sans rien consommer, même
   * au-dessus du quota ; sinon le quota (`null` = sans limite) est vérifié avant l'insertion. Refus :
   * `LimiteOffreError('stockageOctets')`, rien n'est écrit.
   */
  async deposer(
    tenantId: string,
    input: { code: string; mime: MimeFichier; bytes: Buffer; nom: string | null },
    quota: number | null,
  ): Promise<{ media: RcsMediaResume; existant: boolean }> {
    const empreinte = createHash('sha256').update(input.bytes).digest('hex');
    return enTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtext('rcs_media:' || $1))`, [tenantId]);
      const deja = await client.query<Ligne>(
        `select id, code, mime, taille, nom, created_at from rcs_media
          where tenant_id = $1 and empreinte = $2 and supprime_le is null
          order by created_at desc limit 1`,
        [tenantId, empreinte],
      );
      if (deja.rows[0]) return { media: resume(deja.rows[0]), existant: true };
      if (quota !== null) {
        const occ = await client.query<{ n: string }>(
          'select coalesce(sum(taille), 0)::text as n from rcs_media where tenant_id = $1 and supprime_le is null',
          [tenantId],
        );
        if (Number(occ.rows[0]!.n) + input.bytes.length > quota) throw new LimiteOffreError(tenantId, 'stockageOctets', quota);
      }
      const { rows } = await client.query<Ligne>(
        `insert into rcs_media (tenant_id, code, mime, bytes, taille, nom, empreinte)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, code, mime, taille, nom, created_at`,
        [tenantId, input.code, input.mime, input.bytes, input.bytes.length, input.nom, empreinte],
      );
      return { media: resume(rows[0]!), existant: false };
    });
  }

  /** Les fichiers vivants de l'espace, du plus récent au plus ancien. */
  async lister(tenantId: string): Promise<RcsMediaResume[]> {
    const { rows } = await this.pool.query<Ligne>(
      `select id, code, mime, taille, nom, created_at from rcs_media
        where tenant_id = $1 and supprime_le is null order by created_at desc`,
      [tenantId],
    );
    return rows.map(resume);
  }

  /** Le poids des fichiers vivants de l'espace, en octets : ce que le quota compte. */
  async occupation(tenantId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      'select coalesce(sum(taille), 0)::text as n from rcs_media where tenant_id = $1 and supprime_le is null',
      [tenantId],
    );
    return Number(rows[0]!.n);
  }

  /**
   * Ce qui, dans l'espace, cite le fichier et pourrait encore l'envoyer : un scénario (publié OU brouillon), un message
   * RCS enregistré non supprimé, une campagne pas terminée (son message ou un étage de sa chaîne), un brouillon de
   * campagne. Le code (base32 Crockford, sans `%` ni `_`) ne porte aucun caractère spécial de LIKE ; la comparaison ignore
   * la casse, comme `/m/`, qui sert aussi une adresse collée en majuscules.
   * `q` : la connexion de la transaction quand `supprimer` l'appelle sous son verrou (jamais une seconde connexion du pool,
   * sinon dix suppressions simultanées gèlent l'API).
   */
  async utilisations(tenantId: string, code: string, q: Pick<PoolClient, 'query'> = this.pool): Promise<UtilisationMedia[]> {
    const { rows } = await q.query<UtilisationMedia>(
      `with motif as (select '%/m/' || lower($2::text) || '.%' as m)
       select 'scenario' as lieu, w.name as nom from workflows w, motif
        where w.tenant_id = $1 and (lower(w.graph::text) like motif.m or lower(coalesce(w.draft_graph::text, '')) like motif.m)
       union all
       select 'message_rcs', r.name from rcs_messages r, motif
        where r.tenant_id = $1 and r.deleted_at is null and lower(r.content::text) like motif.m
       union all
       select 'campagne', c.name from campaigns c, motif
        where c.tenant_id = $1 and c.status <> 'completed'
          and (lower(coalesce(c.rcs_message::text, '')) like motif.m
               or exists (select 1 from campaign_etages e where e.campaign_id = c.id and lower(coalesce(e.rcs_message::text, '')) like motif.m))
       union all
       select 'brouillon_campagne', d.name from campaign_drafts d, motif
        where d.tenant_id = $1 and lower(d.state::text) like motif.m`,
      [tenantId, code],
    );
    return rows;
  }

  /**
   * Suppression DOUCE : refusée tant que le fichier sert (la liste dit quoi), sinon le fichier sort de la médiathèque et
   * du quota, et reste servi `GRACE_SUPPRESSION_JOURS` jours. Sous le même verrou que le dépôt.
   */
  async supprimer(tenantId: string, code: string): Promise<IssueSuppression> {
    return enTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtext('rcs_media:' || $1))`, [tenantId]);
      const vivant = await client.query('select 1 from rcs_media where tenant_id = $1 and code = $2 and supprime_le is null', [tenantId, code]);
      if (vivant.rowCount === 0) return { issue: 'introuvable' } as const;
      const utilisations = await this.utilisations(tenantId, code, client);
      if (utilisations.length > 0) return { issue: 'utilise', utilisations } as const;
      await client.query('update rcs_media set supprime_le = now() where tenant_id = $1 and code = $2 and supprime_le is null', [tenantId, code]);
      return { issue: 'supprime' } as const;
    });
  }

  /** Efface au plus `taille` fichiers supprimés depuis plus de la grâce ; rend le nombre effacé (`purgerJusquAEpuisement`). */
  async purgerSupprimes(taille: number): Promise<number> {
    const r = await this.pool.query(
      `delete from rcs_media where id in (
         select id from rcs_media
          where supprime_le is not null and supprime_le <= now() - make_interval(days => ${GRACE_SUPPRESSION_JOURS})
          limit $1)`,
      [taille],
    );
    return r.rowCount ?? 0;
  }

  /**
   * Le fichier d'un code DANS CET ESPACE, avec son nom, vivant ou supprimé depuis moins de la grâce (spec médias, § 3.2) :
   * c'est par là que la préparation d'un envoi lit une vidéo ou un PDF, qui n'ont pas d'adresse publique, et que la
   * console ouvre un fichier sous session. Un code d'un autre espace rend null, comme un code inconnu.
   */
  async lireDeLEspace(tenantId: string, code: string): Promise<(RcsMediaFichier & { nom: string | null }) | null> {
    const { rows } = await this.pool.query<{ bytes: Buffer; mime: MimeFichier; nom: string | null }>(
      `select bytes, mime, nom from rcs_media where tenant_id = $1 and code = $2 and ${SERVI}`,
      [tenantId, code],
    );
    return rows[0] ? { bytes: rows[0].bytes, mime: rows[0].mime, nom: rows[0].nom } : null;
  }

  /**
   * Le fichier derrière un code, sans espace (route publique, appelée par l'opérateur), vivant ou supprimé depuis moins
   * de la grâce. null = code inconnu ou purgé : 404, sans dire si le code a existé.
   */
  async getByCode(code: string): Promise<RcsMediaFichier | null> {
    const { rows } = await this.pool.query<{ bytes: Buffer; mime: MimeFichier }>(
      `select bytes, mime from rcs_media where code = $1 and ${SERVI}`,
      [code],
    );
    return rows[0] ? { bytes: rows[0].bytes, mime: rows[0].mime } : null;
  }
}
