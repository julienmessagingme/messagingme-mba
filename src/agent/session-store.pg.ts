import type { Pool } from 'pg';
import type { AgentSession, AgentSessionStatus, AgentSessionStore } from './session-store';

/** Colonnes lues par toutes les requêtes de ce store. `cout_micro_eur` est un `bigint`, donc rendu en `string`. */
const COLONNES = 'id, tenant_id, run_id, agent_id, node_id, wa_id, tours, appels_outils, cout_micro_eur, status';

interface Ligne {
  id: string;
  tenant_id: string;
  run_id: string;
  agent_id: string;
  node_id: string;
  wa_id: string;
  tours: number;
  appels_outils: number;
  cout_micro_eur: string;
  status: AgentSessionStatus;
}

function versSession(r: Ligne): AgentSession {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    runId: r.run_id,
    agentId: r.agent_id,
    nodeId: r.node_id,
    waId: r.wa_id,
    tours: r.tours,
    appelsOutils: r.appels_outils,
    // `bigint` rendu en `string` par node-pg. Converti ici, comme partout ailleurs dans le repo.
    coutMicroEur: Number(r.cout_micro_eur ?? 0),
    status: r.status,
  };
}

/**
 * État multi-tours d'une conversation d'agent (migration 0086).
 *
 * ⚠️ `tenant_id = $x` sur CHAQUE requête, y compris celles qui ciblent déjà un identifiant de session : le
 * pooler est superuser, la RLS est bypassée, ce filtrage est le SEUL contrôle d'isolation entre clients.
 */
export class PgAgentSessionStore implements AgentSessionStore {
  constructor(private readonly pool: Pool) {}

  async open(input: { tenantId: string; runId: string; agentId: string; nodeId: string; waId: string }): Promise<AgentSession> {
    // LÈVE si le parcours a déjà une session vivante : l'index partiel `agent_sessions_run_vivante_idx`
    // (where status = 'en_cours') rend l'invariant incontournable EN BASE. On ne le rattrape pas ici, un
    // second `open` est un bug d'appelant, pas un cas nominal.
    const res = await this.pool.query<Ligne>(
      `insert into agent_sessions (tenant_id, run_id, agent_id, node_id, wa_id)
       values ($1, $2, $3, $4, $5) returning ${COLONNES}`,
      [input.tenantId, input.runId, input.agentId, input.nodeId, input.waId],
    );
    return versSession(res.rows[0]!);
  }

  async byRun(tenantId: string, runId: string): Promise<AgentSession | null> {
    const res = await this.pool.query<Ligne>(
      `select ${COLONNES} from agent_sessions
       where tenant_id = $1 and run_id = $2 and status = 'en_cours' limit 1`,
      [tenantId, runId],
    );
    const r = res.rows[0];
    return r ? versSession(r) : null;
  }

  async prendreLeTour(tenantId: string, sessionId: string, toursAttendus: number): Promise<AgentSession | null> {
    // UNE seule requête : le test et l'incrément sont atomiques, donc deux jobs concurrents ne peuvent pas
    // prendre le même tour. Zéro ligne rendue vaut REJEU, l'appelant doit sortir sans rien faire.
    const res = await this.pool.query<Ligne>(
      `update agent_sessions set tours = tours + 1, derniere_activite = now()
       where id = $1 and tenant_id = $2 and status = 'en_cours' and tours = $3
       returning ${COLONNES}`,
      [sessionId, tenantId, toursAttendus],
    );
    const r = res.rows[0];
    return r ? versSession(r) : null;
  }

  async ajouterAuTranscript(tenantId: string, sessionId: string, entree: unknown): Promise<void> {
    // Concaténation côté BASE (`||`) plutôt que lecture-modification-écriture : deux écritures concurrentes
    // ne peuvent pas s'écraser l'une l'autre, et on ne rapatrie jamais un transcript qui grossit à chaque tour.
    await this.pool.query(
      `update agent_sessions
          set transcript = transcript || $3::jsonb, derniere_activite = now()
        where id = $1 and tenant_id = $2`,
      [sessionId, tenantId, JSON.stringify([entree])],
    );
  }

  async compterAppel(tenantId: string, sessionId: string): Promise<void> {
    // Incrément côté BASE, sans condition de statut : un appel servi doit se compter même si la session vient
    // d'être close par l'outil lui-même (l'escalade humaine clôt, et son appel compte quand même).
    await this.pool.query(
      `update agent_sessions set appels_outils = appels_outils + 1, derniere_activite = now()
        where id = $1 and tenant_id = $2`,
      [sessionId, tenantId],
    );
  }

  async clore(tenantId: string, sessionId: string, status: AgentSessionStatus, sortie?: string): Promise<void> {
    // `status = 'en_cours'` dans le WHERE : clore une session déjà close est sans effet plutôt que d'écraser
    // la cause de sa fin (un rejeu ne doit pas transformer une `sortie` en `erreur`).
    await this.pool.query(
      `update agent_sessions set status = $3, sortie = $4, derniere_activite = now()
        where id = $1 and tenant_id = $2 and status = 'en_cours'`,
      [sessionId, tenantId, status, sortie ?? null],
    );
  }
}
