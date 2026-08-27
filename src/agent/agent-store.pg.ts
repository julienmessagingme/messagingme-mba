import type { Pool } from 'pg';
import type { AgentStore, FicheAgent } from './agent-store';

interface Ligne {
  id: string;
  tenant_id: string;
  mention_ia: string;
  modele: string;
  max_tours: number;
  max_appels_outils: number;
  budget_micro_eur: string;
  inactivite_minutes: number;
  status: 'draft' | 'active' | 'disabled';
}

/** Lecture des fiches d'agent (migration 0086). `tenant_id = $1` sur chaque requête : c'est le seul contrôle
 *  d'isolation, et `node.data.agentId` vient du client, donc il peut pointer l'agent d'un autre tenant. */
export class PgAgentStore implements AgentStore {
  constructor(private readonly pool: Pool) {}

  async byId(tenantId: string, id: string): Promise<FicheAgent | null> {
    const res = await this.pool.query<Ligne>(
      `select id, tenant_id, mention_ia, modele, max_tours, max_appels_outils, budget_micro_eur,
              inactivite_minutes, status
         from agents where tenant_id = $1 and id = $2`,
      [tenantId, id],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      mentionIa: r.mention_ia,
      modele: r.modele,
      plafonds: {
        maxTours: r.max_tours,
        maxAppelsOutils: r.max_appels_outils,
        // `bigint` rendu en `string` par node-pg, converti ici comme partout ailleurs dans le repo.
        budgetMicroEur: Number(r.budget_micro_eur ?? 0),
      },
      inactiviteMinutes: r.inactivite_minutes,
      status: r.status,
    };
  }
}
