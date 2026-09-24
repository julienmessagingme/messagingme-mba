import type { Pool } from 'pg';

/**
 * LE RÉGLAGE DE L'ADAPTATEUR BATCH, une ligne par espace (migration 0177, `integration_batch`).
 *
 * 🔴 LES CLÉS NE SORTENT JAMAIS EN CLAIR DE CE FICHIER VERS UN ÉCRAN : `lire` ne les sélectionne même pas.
 * Seul `secrets` les rend, CHIFFRÉES, au worker qui pousse.
 *
 * ⚠️ `tenant_id = $1` sur chaque requête qui sert un espace. `espacesActifs` est la SEULE lecture transverse,
 * et c'est délibéré : elle alimente le cache de l'émetteur, qui répond « cet espace a-t-il branché un outil ? »
 * sans une requête par signal. Elle exclut un espace dont les clés ont été refusées : ses signaux ne sont plus
 * enfilés tant qu'il ne les a pas corrigées.
 */
export interface VueIntegrationBatch {
  envoyerResume: boolean;
  sansIdentifiant: number;
  sansIdentifiantLe: string | null;
  refusClesLe: string | null;
  majLe: string;
}

export interface SecretsIntegrationBatch {
  cleRestChiffree: string;
  cleProjetChiffree: string;
  envoyerResume: boolean;
  refusClesLe: string | null;
}

export class PgIntegrationBatchStore {
  constructor(private readonly pool: Pool) {}

  async lire(tenantId: string): Promise<VueIntegrationBatch | null> {
    const res = await this.pool.query<{
      envoyer_resume: boolean; sans_identifiant: string; sans_identifiant_le: Date | null; refus_cles_le: Date | null; maj_le: Date;
    }>(
      // `::text` : un bigint arrive en texte chez node-pg, et le dire ici évite qu'un `Number` implicite le cache.
      `select envoyer_resume, sans_identifiant::text as sans_identifiant, sans_identifiant_le, refus_cles_le, maj_le
         from integration_batch where tenant_id = $1`,
      [tenantId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      envoyerResume: r.envoyer_resume,
      sansIdentifiant: Number(r.sans_identifiant),
      sansIdentifiantLe: r.sans_identifiant_le?.toISOString() ?? null,
      refusClesLe: r.refus_cles_le?.toISOString() ?? null,
      majLe: r.maj_le.toISOString(),
    };
  }

  async secrets(tenantId: string): Promise<SecretsIntegrationBatch | null> {
    const res = await this.pool.query<{ cle_rest_chiffree: string; cle_projet_chiffree: string; envoyer_resume: boolean; refus_cles_le: Date | null }>(
      `select cle_rest_chiffree, cle_projet_chiffree, envoyer_resume, refus_cles_le from integration_batch where tenant_id = $1`,
      [tenantId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      cleRestChiffree: r.cle_rest_chiffree,
      cleProjetChiffree: r.cle_projet_chiffree,
      envoyerResume: r.envoyer_resume,
      refusClesLe: r.refus_cles_le?.toISOString() ?? null,
    };
  }

  /**
   * Écrit le réglage. Les clés arrivent DÉJÀ chiffrées ; `null` = garder celle qui est enregistrée.
   *
   * 🔴 `false` = premier branchement sans les DEUX clés : rien n'est écrit (une ligne sans clé ne pousserait
   * rien et ferait croire le contraire). Une clé neuve lève la suspension : c'est le geste qui la corrige.
   */
  async enregistrer(tenantId: string, r: { cleRestChiffree: string | null; cleProjetChiffree: string | null; envoyerResume: boolean }): Promise<boolean> {
    if (r.cleRestChiffree !== null && r.cleProjetChiffree !== null) {
      await this.pool.query(
        `insert into integration_batch (tenant_id, cle_rest_chiffree, cle_projet_chiffree, envoyer_resume)
         values ($1, $2, $3, $4)
         on conflict (tenant_id) do update set
           cle_rest_chiffree = excluded.cle_rest_chiffree,
           cle_projet_chiffree = excluded.cle_projet_chiffree,
           envoyer_resume = excluded.envoyer_resume,
           refus_cles_le = null,
           maj_le = now()`,
        [tenantId, r.cleRestChiffree, r.cleProjetChiffree, r.envoyerResume],
      );
      return true;
    }
    const res = await this.pool.query(
      `update integration_batch set
         cle_rest_chiffree = coalesce($2::text, cle_rest_chiffree),
         cle_projet_chiffree = coalesce($3::text, cle_projet_chiffree),
         envoyer_resume = $4,
         refus_cles_le = case when $2::text is null and $3::text is null then refus_cles_le else null end,
         maj_le = now()
       where tenant_id = $1`,
      [tenantId, r.cleRestChiffree, r.cleProjetChiffree, r.envoyerResume],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async supprimer(tenantId: string): Promise<boolean> {
    const res = await this.pool.query(`delete from integration_batch where tenant_id = $1`, [tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  async espacesActifs(): Promise<Set<string>> {
    const res = await this.pool.query<{ tenant_id: string }>(
      `select tenant_id from integration_batch where refus_cles_le is null`,
    );
    return new Set(res.rows.map((r) => r.tenant_id));
  }

  async noterSansIdentifiant(tenantId: string, n: number): Promise<void> {
    await this.pool.query(
      `update integration_batch set sans_identifiant = sans_identifiant + $2, sans_identifiant_le = now() where tenant_id = $1`,
      [tenantId, n],
    );
  }

  /** L'outil a refusé les clés (401, 403) : on suspend, une fois, jusqu'à ce qu'on en enregistre de nouvelles. */
  async suspendre(tenantId: string): Promise<void> {
    await this.pool.query(
      `update integration_batch set refus_cles_le = now() where tenant_id = $1 and refus_cles_le is null`,
      [tenantId],
    );
  }
}
