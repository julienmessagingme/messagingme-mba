import type { Pool } from 'pg';
import {
  MAX_LIGNES_HISTORIQUE, problemeDeLigne,
  type FiltreHistorique, type HistoriqueStore, type LigneHistorique, type LigneHistoriqueLue,
} from './historique';

/**
 * L'historique des réglages en base (table `reglages_historique`, migration 0146).
 *
 * ⚠️ `tenant_id = $1` sur CHAQUE requête : la connexion passe par le pooler en rôle superuser, donc la RLS
 * est contournée et ce filtrage EST le contrôle d'accès.
 */
export class PgHistoriqueStore implements HistoriqueStore {
  constructor(private readonly pool: Pool) {}

  async ecrire(tenantId: string, l: LigneHistorique): Promise<void> {
    /**
     * 🔴 LA GARDE EST ICI **ET** DANS LE SCHÉMA, ET LES DEUX SONT VOULUES. Celle-ci lève une erreur qui NOMME
     * le problème ; celle de la base est infranchissable mais ressort en violation de contrainte, c'est-à-dire
     * en 500, donc derrière une page Cloudflare qui n'explique rien.
     */
    const probleme = problemeDeLigne(l);
    if (probleme !== null) throw new Error(`historique : ${probleme}`);

    await this.pool.query(
      `insert into reglages_historique
         (tenant_id, surface, surface_id, element, operation, cible, libelle, avant, apres,
          origine, acteur_email, acteur_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)`,
      [
        tenantId, l.surface, l.surfaceId, l.element, l.operation, l.cible, l.libelle,
        l.avant === undefined ? null : JSON.stringify(l.avant),
        l.apres === undefined ? null : JSON.stringify(l.apres),
        l.origine, l.acteurEmail, l.acteurId,
      ],
    );
  }

  async lister(tenantId: string, f: FiltreHistorique): Promise<LigneHistoriqueLue[]> {
    /**
     * 🔴 `is not distinct from` ET NON `=`. Pour le MBA, `surfaceId` vaut `null`, et `null = null` est FAUX
     * en SQL : la requête rendrait ZÉRO ligne, sans aucune erreur, sur la surface qui en a le plus besoin.
     * C'est le mode de panne le plus silencieux d'une colonne nullable.
     */
    const res = await this.pool.query<{
      id: string; surface: 'mba' | 'agent'; surface_id: string | null; element: string;
      operation: string; cible: string | null; libelle: string; avant: unknown; apres: unknown;
      origine: string; acteur_email: string | null; acteur_id: string | null; at: Date;
    }>(
      `select id, surface, surface_id, element, operation, cible, libelle, avant, apres,
              origine, acteur_email, acteur_id, at
         from reglages_historique
        where tenant_id = $1 and surface = $2 and surface_id is not distinct from $3::uuid
        order by at desc
        limit $4`,
      [tenantId, f.surface, f.surfaceId ?? null, Math.min(Math.max(1, f.limite ?? 200), MAX_LIGNES_HISTORIQUE)],
    );
    return res.rows.map((r) => ({
      id: r.id,
      surface: r.surface,
      surfaceId: r.surface_id,
      element: r.element as LigneHistorique['element'],
      operation: r.operation as LigneHistorique['operation'],
      cible: r.cible,
      libelle: r.libelle,
      avant: r.avant,
      apres: r.apres,
      origine: r.origine as LigneHistorique['origine'],
      acteurEmail: r.acteur_email,
      acteurId: r.acteur_id,
      at: r.at.toISOString(),
    }));
  }
}
