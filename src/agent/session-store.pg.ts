import type { Pool } from 'pg';
import type {
  AgentSession, AgentSessionStatus, AgentSessionStore, ConsommationAgent, TourBloque,
} from './session-store';

/** Un entier positif qui tient dans un `integer` Postgres. */
const borner = (n: number): number => Math.min(2_147_483_647, Math.max(1, Math.round(n)));

/** Colonnes lues par toutes les requêtes de ce store. `cout_micro_eur` est un `bigint`, donc rendu en `string`. */
const COLONNES = 'id, tenant_id, run_id, agent_id, node_id, wa_id, tours, appels_outils, cout_micro_eur, status, created_at';

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
  created_at: Date;
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
    coutMicroEur: Number(r.cout_micro_eur ?? 0),
    status: r.status,
    ouvertLe: r.created_at.toISOString(),
  };
}

/**
 * État multi-tours d'une conversation d'agent, en base.
 *
 * 🔴 `tenant_id` sur chaque requête, même celles qui ciblent déjà une session : la RLS est contournée par le
 * pooler, ce filtrage est le seul contrôle d'isolation entre clients.
 */
export class PgAgentSessionStore implements AgentSessionStore {
  constructor(private readonly pool: Pool) {}

  async open(input: { tenantId: string; runId: string; agentId: string; nodeId: string; waId: string }): Promise<AgentSession> {
    // Lève si le parcours a déjà une session vivante : l'index partiel `agent_sessions_run_vivante_idx`
    // (`where status = 'en_cours'`) tient l'invariant en base. Un second `open` est un bug d'appelant.
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
    // Une seule requête : test et incrément atomiques, deux jobs ne prennent pas le même tour ; zéro ligne vaut
    // rejeu. `tour_commence_le` est posé dans la même requête : posé après, un crash laisserait un tour
    // incrémenté sans marque, invisible du balayage.
    const res = await this.pool.query<Ligne>(
      `update agent_sessions set tours = tours + 1, derniere_activite = now(), tour_commence_le = now()
       where id = $1 and tenant_id = $2 and status = 'en_cours' and tours = $3
       returning ${COLONNES}`,
      [sessionId, tenantId, toursAttendus],
    );
    const r = res.rows[0];
    return r ? versSession(r) : null;
  }

  async ajouterAuTranscript(tenantId: string, sessionId: string, entree: unknown): Promise<void> {
    // Concaténation côté base (`||`) : deux écritures concurrentes ne s'écrasent pas, et on ne rapatrie jamais
    // un transcript qui grossit.
    await this.pool.query(
      `update agent_sessions
          set transcript = transcript || $3::jsonb, derniere_activite = now()
        where id = $1 and tenant_id = $2`,
      [sessionId, tenantId, JSON.stringify([entree])],
    );
  }

  async ajouterCout(tenantId: string, sessionId: string, montantMicroEur: number): Promise<void> {
    // Un montant nul ou négatif ne s'écrit pas : un négatif serait un remboursement déguisé sur un compteur
    // qui ne doit que monter.
    const montant = Math.max(0, Math.round(montantMicroEur));
    if (montant === 0) return;
    // Incrément côté base, sans condition de statut : un tour déjà joué a coûté, même si la session vient
    // d'être close.
    await this.pool.query(
      `update agent_sessions set cout_micro_eur = cout_micro_eur + $3::bigint, derniere_activite = now()
        where id = $1 and tenant_id = $2`,
      [sessionId, tenantId, montant],
    );
  }

  async compterAppel(tenantId: string, sessionId: string): Promise<void> {
    // Incrément côté base, sans condition de statut : l'escalade clôt la session, et son appel compte quand même.
    await this.pool.query(
      `update agent_sessions set appels_outils = appels_outils + 1, derniere_activite = now()
        where id = $1 and tenant_id = $2`,
      [sessionId, tenantId],
    );
  }

  async finirLeTour(tenantId: string, sessionId: string): Promise<void> {
    // Le pendant de `prendreLeTour`, sur les sorties qui laissent la session vivante : sans lui, une session
    // saine porterait une marque de tour en vol. `status = 'en_cours'` : on n'exhume pas une session close.
    await this.pool.query(
      `update agent_sessions set tour_commence_le = null
        where id = $1 and tenant_id = $2 and status = 'en_cours'`,
      [sessionId, tenantId],
    );
  }

  /**
   * La sortie due a été appliquée au parcours : la marque peut tomber. `status <> 'en_cours'` est la garde
   * miroir de `finirLeTour` : un tour vivant ne peut pas effacer une marque qui désigne du travail restant.
   */
  async sortieAppliquee(tenantId: string, sessionId: string): Promise<void> {
    await this.pool.query(
      `update agent_sessions set tour_commence_le = null
        where id = $1 and tenant_id = $2 and status <> 'en_cours'`,
      [sessionId, tenantId],
    );
  }

  async clore(
    tenantId: string, sessionId: string, status: AgentSessionStatus, sortie?: string,
    options?: { sortieDue?: boolean },
  ): Promise<void> {
    // `status = 'en_cours'` : clore une session close est sans effet (un rejeu ne transforme pas une `sortie`
    // en `erreur`). La marque reste quand une sortie est due, pour que le balayage retrouve la ligne si
    // l'appelant meurt avant la sortie du parcours.
    await this.pool.query(
      `update agent_sessions
          set status = $3, sortie = $4, derniere_activite = now(),
              tour_commence_le = case when $5::boolean then tour_commence_le else null end
        where id = $1 and tenant_id = $2 and status = 'en_cours'`,
      [sessionId, tenantId, status, sortie ?? null, options?.sortieDue === true],
    );
  }

  /**
   * Réclame les tours en vol depuis trop longtemps, et les clôt dans la même requête : deux workers ne
   * peuvent pas sortir la même session deux fois.
   *
   * La marque est repoussée (`tour_commence_le = now()`), pas effacée : c'est un bail de `AGE_TOUR_MORT_S`
   * contre une reprise concurrente, et la trace qu'une sortie reste à appliquer. D'où le prédicat sans
   * `status` : on réclame aussi les sessions closes dont la sortie est due, et le `case` ne clôt que celles
   * encore `en_cours`. On ne rejoue pas le tour : l'envoi a pu partir avant la mort du worker.
   */
  async reclamerToursBloques(ageSecondes: number, limite: number, sortie: string): Promise<TourBloque[]> {
    const res = await this.pool.query<{ id: string; tenant_id: string; run_id: string; wa_id: string; node_id: string; sortie: string }>(
      `update agent_sessions s
          set status = case when s.status = 'en_cours' then 'erreur' else s.status end,
              sortie = case when s.status = 'en_cours' then $3::text else s.sortie end,
              derniere_activite = now(),
              tour_commence_le = now()
        where s.id in (
          select id from agent_sessions
           where tour_commence_le is not null
             and tour_commence_le < now() - make_interval(secs => $1::int)
           order by tour_commence_le
           limit $2
           for update skip locked
        )
      returning s.id, s.tenant_id, s.run_id, s.wa_id, s.node_id, coalesce(s.sortie, $3::text) as sortie`,
      // Bornés des deux côtés : `make_interval(secs => $1::int)` lève au-delà d'un entier signé 32 bits.
      [borner(ageSecondes), borner(limite), sortie],
    );
    return res.rows.map((r) => ({
      sessionId: r.id, tenantId: r.tenant_id, runId: r.run_id, waId: r.wa_id, nodeId: r.node_id,
      // `coalesce` en SQL : le `returning` d'un UPDATE rend la valeur après écriture, donc la sortie forcée
      // d'une session encore `en_cours`, ou celle d'une session déjà close.
      sortie: r.sortie,
    }));
  }

  /**
   * La consommation de cet agent sur une fenêtre glissante, jamais depuis toujours : la fenêtre sert l'index
   * `(tenant_id, created_at desc)`. `agent_id` n'est pas indexé : la fenêtre borne déjà le balayage, et un
   * index de plus se paierait à l'écriture sur le chemin chaud.
   */
  async consommation(tenantId: string, agentId: string, jours: number): Promise<ConsommationAgent> {
    const { rows } = await this.pool.query<{
      sessions: string; tokens_in: string; tokens_out: string; cout: string;
    }>(
      `select count(*)::text as sessions,
              coalesce(sum(tokens_in), 0)::text as tokens_in,
              coalesce(sum(tokens_out), 0)::text as tokens_out,
              coalesce(sum(cout_micro_eur), 0)::text as cout
         from agent_sessions
        where tenant_id = $1 and agent_id = $2
          and created_at > now() - make_interval(days => $3)`,
      [tenantId, agentId, jours],
    );
    const r = rows[0];
    return {
      sessions: Number(r?.sessions ?? 0),
      tokensEntree: Number(r?.tokens_in ?? 0),
      tokensSortie: Number(r?.tokens_out ?? 0),
      coutMicroEur: Number(r?.cout ?? 0),
      jours,
    };
  }

  /**
   * Les messages échangés dans les conversations que cet agent a tenues sur la fenêtre.
   *
   * 🔴 `conversation_messages` ne porte pas de `tenant_id` : la jointure sur `conversations` est le seul
   * contrôle d'isolation, sans elle on compterait les messages de tous les espaces. `not c.is_test`, comme le
   * reste des statistiques. Le rapprochement se fait sur `wa_id`, unique par espace dans `conversations` :
   * `agent_sessions` n'a pas de `conversation_id`. Même fenêtre glissante que `consommation`, affichée à côté.
   */
  async messagesTenus(tenantId: string, agentId: string, jours: number): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `select count(*)::text as n
         from conversation_messages m
         join conversations c on c.id = m.conversation_id
        where c.tenant_id = $1
          and not c.is_test
          and m.created_at > now() - make_interval(days => $3)
          and c.wa_id in (
            select s.wa_id from agent_sessions s
             where s.tenant_id = $1 and s.agent_id = $2
               and s.created_at > now() - make_interval(days => $3)
          )`,
      [tenantId, agentId, jours],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
