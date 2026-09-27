import type { Pool } from 'pg';
import {
  MAX_LIGNES_HISTORIQUE, problemeDeLigne,
  type FiltreHistorique, type HistoriqueStore, type LigneHistorique, type LigneHistoriqueLue,
} from './historique';

/**
 * L'historique des réglages en base (`reglages_historique`). 🔴 `tenant_id = $1` sur chaque requête : le pooler
 * contourne la RLS, ce filtre est le contrôle d'accès.
 */
export class PgHistoriqueStore implements HistoriqueStore {
  constructor(private readonly pool: Pool) {}

  async ecrire(tenantId: string, l: LigneHistorique): Promise<void> {
    // Garde ici et dans le schéma : celle-ci nomme le problème, celle de la base rendrait un 500 muet.
    const probleme = problemeDeLigne(l);
    if (probleme !== null) throw new Error(`historique : ${probleme}`);

    // L'e-mail de l'acteur se résout ici, dans l'INSERT : la colonne est dénormalisée pour qu'un départ ne rende pas
    // l'historique anonyme, et la résoudre au point de passage unique la remplit pour tous les appelants. Le
    // sous-select porte `tenant_id = $1` ; un `acteurEmail` fourni gagne (compte déjà parti).
    await this.pool.query(
      `insert into reglages_historique
         (tenant_id, surface, surface_id, element, operation, cible, libelle, avant, apres,
          origine, acteur_email, acteur_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10,
               coalesce($11, (select email from users where id = $12::uuid and tenant_id = $1)),
               $12::uuid)`,
      [
        tenantId, l.surface, l.surfaceId, l.element, l.operation, l.cible, l.libelle,
        l.avant === undefined ? null : JSON.stringify(l.avant),
        l.apres === undefined ? null : JSON.stringify(l.apres),
        l.origine, l.acteurEmail, l.acteurId,
      ],
    );
  }

  async lister(tenantId: string, f: FiltreHistorique): Promise<LigneHistoriqueLue[]> {
    // `is not distinct from` et non `=` : pour le MBA, `surfaceId` vaut `null`, et `null = null` est faux en SQL.
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
