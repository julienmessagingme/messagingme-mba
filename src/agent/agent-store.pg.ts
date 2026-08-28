import type { Pool } from 'pg';
import type { AgentResume, AgentStore, FicheAgent, SortieAgent } from './agent-store';
import { asArray, asRecord } from '../webhooks/json';

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

  async listActifs(tenantId: string): Promise<AgentResume[]> {
    const res = await this.pool.query<{ id: string; label: string; fiche: unknown }>(
      `select id, label, fiche from agents where tenant_id = $1 and status = 'active' order by lower(label)`,
      [tenantId],
    );
    return res.rows.map((r) => ({ id: r.id, label: r.label, sorties: sortiesDeLaFiche(r.fiche) }));
  }
}

/**
 * Les règles d'arrêt d'une fiche, lues DÉFENSIVEMENT : `fiche` est du jsonb écrit par l'IA de construction,
 * donc opaque. Une entrée inutilisable est écartée plutôt que de faire tomber le builder, qui serait alors
 * inutilisable pour tout le scénario à cause d'une seule ligne mal formée.
 *
 * Le code est contraint au même alphabet que les noms d'outils (`[a-z0-9_]`) : il finit dans un handle
 * d'arête `sortie:<code>`, et un caractère exotique y serait une source d'écarts silencieux.
 */
export function sortiesDeLaFiche(fiche: unknown): SortieAgent[] {
  const out: SortieAgent[] = [];
  const vus = new Set<string>();
  for (const brut of asArray(asRecord(fiche).sorties)) {
    const o = asRecord(brut);
    const code = typeof o.code === 'string' ? o.code.trim().toLowerCase() : '';
    if (!/^[a-z0-9_]{1,32}$/.test(code) || vus.has(code)) continue;
    vus.add(code);
    out.push({ code, label: typeof o.label === 'string' && o.label.trim() !== '' ? o.label.trim() : code });
  }
  return out;
}
