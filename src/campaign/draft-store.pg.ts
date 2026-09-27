import type { Pool } from 'pg';

/** Un brouillon de composition : le nom saisi, et l'état de l'écran pour pouvoir reprendre. */
export interface CampaignDraft {
  id: string;
  name: string;
  /** État du formulaire, forme libre (le formulaire évolue plus vite qu'un schéma de colonnes). */
  state: Record<string, unknown>;
  updatedAt: Date;
}

/**
 * Brouillons de campagne : une campagne en cours de composition, retrouvable après avoir quitté l'écran.
 *
 * Aucun rapport avec `campaigns.status = 'draft'` (campagne complète non lancée) : ce store ne touche jamais
 * au moteur d'envoi, aucune écriture ici ne peut produire un message.
 *
 * 🔴 Toutes les requêtes portent `tenant_id` : c'est le seul contrôle d'isolation (rôle service).
 */
export class PgCampaignDraftStore {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string): Promise<CampaignDraft[]> {
    const res = await this.pool.query<{ id: string; name: string; state: Record<string, unknown>; updated_at: Date }>(
      `select id, name, state, updated_at from campaign_drafts
        where tenant_id = $1 order by updated_at desc`,
      [tenantId],
    );
    return res.rows.map((r) => ({ id: r.id, name: r.name, state: r.state ?? {}, updatedAt: r.updated_at }));
  }

  async create(tenantId: string, name: string, state: Record<string, unknown> = {}): Promise<CampaignDraft> {
    const res = await this.pool.query<{ id: string; name: string; state: Record<string, unknown>; updated_at: Date }>(
      `insert into campaign_drafts (tenant_id, name, state) values ($1, $2, $3::jsonb)
       returning id, name, state, updated_at`,
      [tenantId, name, JSON.stringify(state)],
    );
    const r = res.rows[0]!;
    return { id: r.id, name: r.name, state: r.state ?? {}, updatedAt: r.updated_at };
  }

  /**
   * Rend `false` si le brouillon n'existe pas ou appartient à un autre tenant (l'appelant en fait un 404).
   * Jamais de création silencieuse : elle permettrait de semer des brouillons chez autrui en devinant des ids.
   */
  async update(tenantId: string, id: string, name: string, state: Record<string, unknown>): Promise<boolean> {
    const res = await this.pool.query(
      `update campaign_drafts set name = $3, state = $4::jsonb, updated_at = now()
        where id = $1 and tenant_id = $2`,
      [id, tenantId, name, JSON.stringify(state)],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Supprime un brouillon. Rend `false` s'il n'existait pas (ou pas pour ce tenant). */
  async remove(tenantId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      `delete from campaign_drafts where id = $1 and tenant_id = $2`,
      [id, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
