import type { Pool } from 'pg';

/**
 * Une ligne de `channelsme_posts` : le rattachement entre une publication faite CHEZ Channels Me et le lien
 * de chaine qu elle portait.
 *
 * 🔴 Aucun statut ici. Le statut d un post se lit en direct chez Channels Me : le miroiter creerait une
 * copie a resynchroniser, donc une file de rattrapage, donc un etat qui ment des qu elle prend du retard.
 */
export interface PostRow {
  id: string;
  tenantId: string;
  /** Identifiant du message CHEZ Channels Me, pas chez nous. */
  cmMessageId: string;
  linkId: string | null;
  createdAt: string;
}

/** ⚠️ Liste tenue A LA MAIN : ajouter une colonne oblige a toucher aussi `PostRowBrut` et `versPost`. */
const COLS = 'id, tenant_id, cm_message_id, link_id, created_at';

/** Forme brute d une ligne `channelsme_posts` (colonnes de COLS) telle que Postgres la rend. */
interface PostRowBrut {
  id: string;
  tenant_id: string;
  cm_message_id: string;
  link_id: string | null;
  created_at: Date;
}

function versPost(r: PostRowBrut): PostRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    cmMessageId: r.cm_message_id,
    linkId: r.link_id,
    createdAt: r.created_at.toISOString(),
  };
}

/** Les publications d un tenant. Table de TRACE : on y ecrit apres une publication reussie, on y lit pour
 *  rattacher chaque post a son lien et donc a son scenario. */
export class PgChannelsMePostStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Trace une publication REUSSIE.
   *
   * `Promise<void>` et donc aucun `returning` : l appelant vient de publier chez Channels Me, il tient deja
   * l identifiant du message, il n a rien a relire de cette ligne.
   */
  async create(tenantId: string, p: { cmMessageId: string; linkId: string | null }): Promise<void> {
    await this.pool.query(
      `insert into channelsme_posts (tenant_id, cm_message_id, link_id) values ($1,$2,$3)`,
      [tenantId, p.cmMessageId, p.linkId],
    );
  }

  /** 🔴 `order by created_at desc` : c est l ordre de l index channelsme_posts_tenant_idx (tenant_id, created_at desc). */
  async list(tenantId: string): Promise<PostRow[]> {
    const { rows } = await this.pool.query<PostRowBrut>(
      `select ${COLS} from channelsme_posts where tenant_id=$1 order by created_at desc`,
      [tenantId],
    );
    return rows.map(versPost);
  }
}
