import type { Pool } from 'pg';

/**
 * Une ligne de `channelsme_posts` : le rattachement entre une publication faite chez Channels Me et le lien
 * de chaîne qu'elle portait. Aucun statut ici : il se lit en direct chez Channels Me, le miroiter ferait une
 * copie qui ment dès qu'elle prend du retard.
 */
export interface PostRow {
  id: string;
  tenantId: string;
  /** Identifiant du message chez Channels Me, pas chez nous. */
  cmMessageId: string;
  linkId: string | null;
  createdAt: string;
}

/** Liste tenue à la main : une colonne ajoutée ici doit l'être aussi dans `PostRowBrut` et `versPost`. */
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

/** Les publications d'un tenant, table de trace : écrite après une publication réussie, lue pour rattacher
 *  chaque post à son lien, donc à son scénario. */
export class PgChannelsMePostStore {
  constructor(private readonly pool: Pool) {}

  /** Trace une publication réussie. Aucun `returning` : l'appelant tient déjà l'identifiant du message. */
  async create(tenantId: string, p: { cmMessageId: string; linkId: string | null }): Promise<void> {
    await this.pool.query(
      `insert into channelsme_posts (tenant_id, cm_message_id, link_id) values ($1,$2,$3)`,
      [tenantId, p.cmMessageId, p.linkId],
    );
  }

  /** `order by created_at desc` : l'ordre de l'index `channelsme_posts_tenant_idx` (tenant_id, created_at desc). */
  async list(tenantId: string): Promise<PostRow[]> {
    const { rows } = await this.pool.query<PostRowBrut>(
      `select ${COLS} from channelsme_posts where tenant_id=$1 order by created_at desc`,
      [tenantId],
    );
    return rows.map(versPost);
  }
}
