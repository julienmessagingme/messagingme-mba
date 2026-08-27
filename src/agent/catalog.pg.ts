import type { Pool } from 'pg';
import type { JournalAppels, OutilDefini, ToolCatalog } from './catalog';
import { asRecord } from '../webhooks/json';

interface Ligne {
  id: string;
  tenant_id: string;
  agent_id: string;
  origin: OutilDefini['origin'];
  name: string;
  description: string;
  params: unknown;
  binding: unknown;
  output_paths: string[] | null;
  risk: OutilDefini['risk'];
  timeout_ms: number;
  max_bytes: number;
  autonome: boolean;
}

/** Colonnes lues par les deux requêtes. Une seule liste : deux projections divergentes finiraient par ne plus
 *  rendre le même outil selon le chemin, et le chemin qui compte est celui de l'exécution. */
const COLONNES = `id, tenant_id, agent_id, origin, name, description, params, binding, output_paths,
                  risk, timeout_ms, max_bytes, autonome`;

function versOutil(r: Ligne): OutilDefini {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    agentId: r.agent_id,
    origin: r.origin,
    name: r.name,
    description: r.description,
    params: r.params,
    // `binding` est du jsonb, donc opaque : lu par le helper défensif maison plutôt qu'affirmé par un `as`.
    // Un scalaire ou un null donne un objet vide, et le résolveur refuse alors proprement.
    binding: asRecord(r.binding),
    outputPaths: r.output_paths ?? [],
    risk: r.risk,
    timeoutMs: r.timeout_ms,
    maxBytes: r.max_bytes,
    autonome: r.autonome,
  };
}

/**
 * Lecture du catalogue d'outils (migration 0086).
 *
 * 🔴 `and actif` est dans le SQL des DEUX requêtes, et `tenant_id = $1 and agent_id = $2` aussi. Le nom
 * d'outil vient du modèle, donc d'un texte qu'un contact peut influencer : c'est la clause `where` qui
 * empêche d'appeler l'outil d'un autre agent ou d'un autre client (voir `ToolCatalog.byName`).
 */
export class PgToolCatalog implements ToolCatalog {
  constructor(private readonly pool: Pool) {}

  async byName(tenantId: string, agentId: string, name: string): Promise<OutilDefini | null> {
    const res = await this.pool.query<Ligne>(
      `select ${COLONNES} from agent_tools
        where tenant_id = $1 and agent_id = $2 and name = $3 and actif`,
      [tenantId, agentId, name],
    );
    const r = res.rows[0];
    return r ? versOutil(r) : null;
  }

  async listActifs(tenantId: string, agentId: string): Promise<OutilDefini[]> {
    const res = await this.pool.query<Ligne>(
      `select ${COLONNES} from agent_tools
        where tenant_id = $1 and agent_id = $2 and actif order by name`,
      [tenantId, agentId],
    );
    return res.rows.map(versOutil);
  }
}

/** Journal des appels d'outils. Le contrat et ses raisons sont sur `JournalAppels` (`./catalog`). */
export class PgJournalAppels implements JournalAppels {
  constructor(private readonly pool: Pool) {}

  async ouvrir(input: {
    tenantId: string; sessionId: string; toolId: string | null; toolName: string; origin: string; argsRediges: unknown;
  }): Promise<string> {
    // `refuse` à l'ouverture : une ligne que rien ne vient clore (process tué en plein appel) reste ainsi
    // lisible comme « tentée, jamais aboutie » plutôt que de se faire passer pour un succès.
    const res = await this.pool.query<{ id: string }>(
      `insert into agent_tool_calls (tenant_id, session_id, tool_id, tool_name, origin, args_rediges, status)
       values ($1, $2, $3, $4, $5, $6::jsonb, 'refuse') returning id`,
      [input.tenantId, input.sessionId, input.toolId, input.toolName, input.origin, JSON.stringify(input.argsRediges ?? null)],
    );
    return res.rows[0]!.id;
  }

  async clore(input: {
    tenantId: string; id: string; status: string; httpStatus?: number; dureeMs: number; tailleReponse?: number; erreur?: string;
  }): Promise<void> {
    await this.pool.query(
      `update agent_tool_calls
          set status = $3, http_status = $4, duree_ms = $5, taille_reponse = $6, erreur = $7
        where tenant_id = $1 and id = $2`,
      [
        input.tenantId, input.id, input.status,
        input.httpStatus ?? null, input.dureeMs, input.tailleReponse ?? null, input.erreur ?? null,
      ],
    );
  }
}
