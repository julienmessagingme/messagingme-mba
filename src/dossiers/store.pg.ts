import type { Pool } from 'pg';
import { MAX_DOSSIERS_PAR_TYPE, type TypeDossier } from './regles';

/** Un dossier, tel que la console l'affiche. */
export interface Dossier { id: string; nom: string }

/**
 * Le magasin des dossiers (migration 0229). 🔴 L'ISOLATION ENTRE ESPACES EST ICI : la connexion est un rôle qui
 * contourne la RLS, donc chaque requête porte `tenant_id = $1`, et un dossier n'est accepté que de l'espace ET du type
 * demandé (un dossier de templates ne range pas un scénario, un dossier d'un autre espace ne range rien).
 */
export interface DossierStore {
  lister(tenantId: string, type: TypeDossier): Promise<Dossier[]>;
  /** Clé -> dossier : l'id d'un scénario, ou le NOM d'un template (toutes ses langues suivent). */
  rangement(tenantId: string, type: TypeDossier): Promise<Record<string, string>>;
  creer(tenantId: string, type: TypeDossier, nom: string): Promise<Dossier | 'pris' | 'plein'>;
  renommer(tenantId: string, id: string, nom: string): Promise<Dossier | 'pris' | null>;
  supprimer(tenantId: string, id: string): Promise<boolean>;
  /** Range des clés dans un dossier, ou dans « Sans dossier » (`null`). Rend le nombre d'éléments rangés. */
  ranger(tenantId: string, type: TypeDossier, cles: readonly string[], dossierId: string | null): Promise<number | 'dossier_inconnu'>;
}

/** Une violation d'unicité (23505) : le nom est pris. Une clé étrangère (23503) : le dossier a disparu entre-temps. */
const codeDe = (err: unknown): string | undefined =>
  (err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : undefined);

export class PgDossierStore implements DossierStore {
  constructor(private readonly pool: Pool) {}

  async lister(tenantId: string, type: TypeDossier): Promise<Dossier[]> {
    const r = await this.pool.query<Dossier>(
      'select id, nom from dossiers where tenant_id = $1 and type = $2 order by lower(nom), id',
      [tenantId, type],
    );
    return r.rows;
  }

  async rangement(tenantId: string, type: TypeDossier): Promise<Record<string, string>> {
    // Le scénario système du répondeur (`systeme is not null`) n'est ni listé ni rangé, comme partout dans la console.
    const r = type === 'scenario'
      ? await this.pool.query<{ cle: string; dossier_id: string }>(
        `select id as cle, dossier_id from workflows
          where tenant_id = $1 and systeme is null and dossier_id is not null`,
        [tenantId],
      )
      : await this.pool.query<{ cle: string; dossier_id: string }>(
        'select template_name as cle, dossier_id from template_dossiers where tenant_id = $1',
        [tenantId],
      );
    return Object.fromEntries(r.rows.map((l) => [l.cle, l.dossier_id]));
  }

  async creer(tenantId: string, type: TypeDossier, nom: string): Promise<Dossier | 'pris' | 'plein'> {
    try {
      // Le plafond se lit dans la même instruction : deux créations simultanées peuvent le dépasser d'une unité, ce
      // qui ne casse rien (il protège la lisibilité de la barre, pas une ressource).
      const r = await this.pool.query<Dossier>(
        `insert into dossiers (tenant_id, type, nom)
         select $1, $2, $3
          where (select count(*) from dossiers where tenant_id = $1 and type = $2) < $4
         returning id, nom`,
        [tenantId, type, nom, MAX_DOSSIERS_PAR_TYPE],
      );
      return r.rows[0] ?? 'plein';
    } catch (err) {
      if (codeDe(err) === '23505') return 'pris';
      throw err;
    }
  }

  async renommer(tenantId: string, id: string, nom: string): Promise<Dossier | 'pris' | null> {
    try {
      const r = await this.pool.query<Dossier>(
        'update dossiers set nom = $3 where tenant_id = $1 and id = $2 returning id, nom',
        [tenantId, id, nom],
      );
      return r.rows[0] ?? null;
    } catch (err) {
      if (codeDe(err) === '23505') return 'pris';
      throw err;
    }
  }

  async supprimer(tenantId: string, id: string): Promise<boolean> {
    // Les scénarios repassent à null (`on delete set null`), les rangements de templates partent (`on delete cascade`).
    const r = await this.pool.query('delete from dossiers where tenant_id = $1 and id = $2', [tenantId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async ranger(tenantId: string, type: TypeDossier, cles: readonly string[], dossierId: string | null): Promise<number | 'dossier_inconnu'> {
    if (dossierId !== null) {
      const d = await this.pool.query('select 1 from dossiers where tenant_id = $1 and type = $2 and id = $3', [tenantId, type, dossierId]);
      if (d.rowCount === 0) return 'dossier_inconnu';
    }
    if (cles.length === 0) return 0;
    try {
      if (type === 'scenario') {
        const r = await this.pool.query(
          `update workflows set dossier_id = $3
            where tenant_id = $1 and id = any($2::uuid[]) and systeme is null`,
          [tenantId, cles, dossierId],
        );
        return r.rowCount ?? 0;
      }
      if (dossierId === null) {
        const r = await this.pool.query(
          'delete from template_dossiers where tenant_id = $1 and template_name = any($2::text[])',
          [tenantId, cles],
        );
        return r.rowCount ?? 0;
      }
      const r = await this.pool.query(
        `insert into template_dossiers (tenant_id, template_name, dossier_id)
         select $1, n, $3 from unnest($2::text[]) as n
         on conflict (tenant_id, template_name) do update set dossier_id = excluded.dossier_id`,
        [tenantId, [...new Set(cles)], dossierId],
      );
      return r.rowCount ?? 0;
    } catch (err) {
      // Le dossier supprimé par un autre admin entre la vérification et le rangement : rien n'est rangé à moitié.
      if (codeDe(err) === '23503') return 'dossier_inconnu';
      throw err;
    }
  }
}
