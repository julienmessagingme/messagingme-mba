import type { Pool } from 'pg';
import type { EntreeDeLaListe, ListeStore } from './liste';

/**
 * La mémoire de la liste de l'agent de Meta (`mba_liste`, migration 0195) : une ligne par contact que la plateforme
 * lui a confié. Toutes les lectures passent par la clé primaire `(tenant_id, wa_id)`, et chacune est scopée à
 * l'espace. La purge d'un contact supprime sa ligne dans sa propre transaction (`PgContactStore.purgeMany`).
 */
export class PgListeStore implements ListeStore {
  constructor(private readonly pool: Pool) {}

  async presents(tenantId: string, waIds: readonly string[]): Promise<Set<string>> {
    if (waIds.length === 0) return new Set();
    const res = await this.pool.query<{ wa_id: string }>(
      `select wa_id from mba_liste where tenant_id = $1 and wa_id = any($2::text[])`,
      [tenantId, [...waIds]],
    );
    return new Set(res.rows.map((r) => r.wa_id));
  }

  async trouver(tenantId: string, waId: string): Promise<EntreeDeLaListe | null> {
    const res = await this.pool.query<{ phone_number_id: string; entree_id: string }>(
      `select phone_number_id, entree_id from mba_liste where tenant_id = $1 and wa_id = $2`,
      [tenantId, waId],
    );
    const r = res.rows[0];
    return r ? { phoneNumberId: r.phone_number_id, entreeId: r.entree_id } : null;
  }

  /**
   * Idempotent : deux confiés simultanés du même contact aboutissent à la même entrée chez Meta (le second ajout
   * y rend un doublon, que la relecture résout). Un conflit ne doit donc jamais lever, sinon la compensation de
   * `ajouter` retirerait chez Meta l'entrée que le premier vient d'enregistrer.
   */
  async poser(tenantId: string, waId: string, phoneNumberId: string, entreeId: string): Promise<void> {
    await this.pool.query(
      `insert into mba_liste (tenant_id, wa_id, phone_number_id, entree_id) values ($1, $2, $3, $4)
       on conflict (tenant_id, wa_id) do update set phone_number_id = excluded.phone_number_id, entree_id = excluded.entree_id`,
      [tenantId, waId, phoneNumberId, entreeId],
    );
  }

  async supprimer(tenantId: string, waId: string): Promise<void> {
    await this.pool.query(`delete from mba_liste where tenant_id = $1 and wa_id = $2`, [tenantId, waId]);
  }
}
