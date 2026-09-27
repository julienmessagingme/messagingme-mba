import type { Pool } from 'pg';
import type { MimeImage } from './image';

/** Un visuel, sans ses octets : ce que la médiathèque affiche. */
export interface RcsMediaResume {
  id: string;
  code: string;
  mime: MimeImage;
  taille: number;
  nom: string | null;
  createdAt: string;
}

/** Un visuel servi : les octets et leur type réel (celui déduit à l'écriture, jamais un type déclaré). */
export interface RcsMediaFichier {
  bytes: Buffer;
  mime: MimeImage;
}

/**
 * Visuels des messages RCS (`rcs_media`). 🔴 L'opérateur télécom va chercher l'image sur une URL publique,
 * sans session : `getByCode` ne prend pas de tenant, c'est le code (130 bits) qui tient l'accès. Toutes les
 * autres opérations sont scopées tenant.
 */
export class PgRcsMediaStore {
  constructor(private readonly pool: Pool) {}

  /** Enregistre un visuel déjà validé (signature lue, poids borné) et rend son résumé. */
  async create(
    tenantId: string,
    input: { code: string; mime: MimeImage; bytes: Buffer; nom: string | null },
  ): Promise<RcsMediaResume> {
    const { rows } = await this.pool.query<{
      id: string; code: string; mime: MimeImage; taille: number; nom: string | null; created_at: Date;
    }>(
      `insert into rcs_media (tenant_id, code, mime, bytes, taille, nom)
       values ($1, $2, $3, $4, $5, $6)
       returning id, code, mime, taille, nom, created_at`,
      [tenantId, input.code, input.mime, input.bytes, input.bytes.length, input.nom],
    );
    const r = rows[0]!;
    return { id: r.id, code: r.code, mime: r.mime, taille: r.taille, nom: r.nom, createdAt: r.created_at.toISOString() };
  }

  /**
   * Le fichier derrière un code, sans tenant (route publique, appelée par l'opérateur). null = code inconnu :
   * 404, sans dire si le code a existé.
   */
  async getByCode(code: string): Promise<RcsMediaFichier | null> {
    const { rows } = await this.pool.query<{ bytes: Buffer; mime: MimeImage }>(
      'select bytes, mime from rcs_media where code = $1',
      [code],
    );
    return rows[0] ? { bytes: rows[0].bytes, mime: rows[0].mime } : null;
  }

  /** Médiathèque d'un workspace. Les octets ne sont jamais chargés ici : une liste de dix visuels ferait
   *  sinon transiter vingt mégaoctets pour afficher des vignettes. */
  async list(tenantId: string): Promise<RcsMediaResume[]> {
    const { rows } = await this.pool.query<{
      id: string; code: string; mime: MimeImage; taille: number; nom: string | null; created_at: Date;
    }>(
      `select id, code, mime, taille, nom, created_at from rcs_media
       where tenant_id = $1 order by created_at desc limit 100`,
      [tenantId],
    );
    return rows.map((r) => ({
      id: r.id, code: r.code, mime: r.mime, taille: r.taille, nom: r.nom, createdAt: r.created_at.toISOString(),
    }));
  }

  /**
   * Supprime un visuel, scope tenant dans le where : un identifiant d'un autre workspace ne supprime rien.
   * Suppression dure, à la différence des modèles et des messages : ce qui compte est que le visuel cesse
   * d'être servi publiquement. Un message déjà envoyé qui pointait dessus affichera une image cassée.
   */
  async remove(tenantId: string, id: string): Promise<boolean> {
    const res = await this.pool.query('delete from rcs_media where tenant_id = $1 and id = $2', [tenantId, id]);
    return (res.rowCount ?? 0) > 0;
  }
}
