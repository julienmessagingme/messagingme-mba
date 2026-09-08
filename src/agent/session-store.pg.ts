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
    // `bigint` rendu en `string` par node-pg. Converti ici, comme partout ailleurs dans le repo.
    coutMicroEur: Number(r.cout_micro_eur ?? 0),
    status: r.status,
    ouvertLe: r.created_at.toISOString(),
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
    // `tour_commence_le` est posé ICI, dans la MÊME requête que l'incrément (migration 0112) : c'est ce qui
    // rend le marqueur fiable. Posé après, un crash entre les deux laisserait un tour incrémenté sans marque,
    // donc invisible du balayage, exactement le cas qu'on vient fermer.
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
    // Concaténation côté BASE (`||`) plutôt que lecture-modification-écriture : deux écritures concurrentes
    // ne peuvent pas s'écraser l'une l'autre, et on ne rapatrie jamais un transcript qui grossit à chaque tour.
    await this.pool.query(
      `update agent_sessions
          set transcript = transcript || $3::jsonb, derniere_activite = now()
        where id = $1 and tenant_id = $2`,
      [sessionId, tenantId, JSON.stringify([entree])],
    );
  }

  async ajouterCout(tenantId: string, sessionId: string, montantMicroEur: number): Promise<void> {
    // Un montant nul ou négatif ne s'écrit pas : il ne dirait rien, et un négatif serait un remboursement
    // déguisé sur un compteur qui ne doit que monter.
    const montant = Math.max(0, Math.round(montantMicroEur));
    if (montant === 0) return;
    // Incrément côté BASE, comme `compterAppel` : deux tours concurrents ne s'écrasent pas, et sans condition
    // de statut parce qu'un tour déjà joué a déjà coûté, même si la session vient d'être close.
    await this.pool.query(
      `update agent_sessions set cout_micro_eur = cout_micro_eur + $3::bigint, derniere_activite = now()
        where id = $1 and tenant_id = $2`,
      [sessionId, tenantId, montant],
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

  async finirLeTour(tenantId: string, sessionId: string): Promise<void> {
    // Le pendant de `prendreLeTour`. Appelé sur les sorties qui laissent la session VIVANTE (l'agent a
    // répondu et attend, ou la main est passée à un humain) : sans lui, une session parfaitement saine
    // porterait une marque de tour en vol jusqu'à ce que le balayage la tue.
    // `status = 'en_cours'` dans le WHERE pour la même raison que `clore` : on n'exhume pas une session close.
    await this.pool.query(
      `update agent_sessions set tour_commence_le = null
        where id = $1 and tenant_id = $2 and status = 'en_cours'`,
      [sessionId, tenantId],
    );
  }

  /**
   * La sortie due a été appliquée au parcours : la marque peut tomber.
   *
   * `status <> 'en_cours'` est la garde MIROIR de celle de `finirLeTour`, et elle a la même fonction : un
   * tour encore vivant ne doit pas pouvoir effacer une marque qui désigne du travail restant. Les deux
   * méthodes se partagent ainsi le marqueur sans jamais pouvoir se marcher dessus.
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
    // `status = 'en_cours'` dans le WHERE : clore une session déjà close est sans effet plutôt que d'écraser
    // la cause de sa fin (un rejeu ne doit pas transformer une `sortie` en `erreur`).
    //
    // `tour_commence_le` retombe à null SAUF quand une sortie reste due : la marque est alors ce qui permet
    // au balayage de retrouver la ligne si l'appelant meurt entre la clôture et la sortie du parcours. Elle
    // est effacée par `finirLeTour`, une fois la sortie appliquée. Cf. le contrat, qui porte le raisonnement.
    await this.pool.query(
      `update agent_sessions
          set status = $3, sortie = $4, derniere_activite = now(),
              tour_commence_le = case when $5::boolean then tour_commence_le else null end
        where id = $1 and tenant_id = $2 and status = 'en_cours'`,
      [sessionId, tenantId, status, sortie ?? null, options?.sortieDue === true],
    );
  }

  /**
   * RÉCLAME les tours en vol depuis trop longtemps, et les clôt dans le même mouvement.
   *
   * 🔴 Réclamation et clôture en UNE requête, comme le claim du balayage de réveil : deux workers qui
   * balaient en même temps ne peuvent pas sortir la même session deux fois, donc le scénario ne prend pas
   * deux fois sa branche d'échec. Le `returning` rend de quoi faire sortir le parcours, ce qui suit.
   *
   * 🔴 LA MARQUE EST REPOUSSÉE, PAS EFFACÉE (contre-audit du 2026-09-03). Elle l'était, et la ligne devenait
   * alors inatteignable pour DEUX raisons à la fois : plus `en_cours`, et plus de marqueur. Si la sortie du
   * parcours échouait juste après, plus rien au monde ne rattrapait ce parcours. `tour_commence_le = now()`
   * fait donc les deux à la fois : un BAIL de quinze minutes (`AGE_TOUR_MORT_S`) qui empêche un autre passage de reprendre la même
   * ligne, et la trace qu'il reste une sortie à appliquer. Le prochain passage la reprendra tant que
   * `finirLeTour` ne l'a pas effacée.
   *
   * ⚠️ D'où le prédicat SANS `status` : le balayage réclame aussi des sessions DÉJÀ closes, celles dont la
   * sortie est restée due. Le `case` ne clôt que celles qui sont encore `en_cours`, pour ne pas réécrire la
   * cause de fin d'une session close proprement (un rejeu ne transforme pas une `sortie` en `erreur`).
   *
   * On ne REJOUE PAS le tour, et c'est un choix tranché : le worker a pu mourir APRÈS avoir envoyé le
   * message au contact, et rien en base ne permet de le savoir. Rejouer risquerait un doublon chez le
   * contact ; clore fait au pire répéter la branche d'échec du scénario, qui est prévue pour ça.
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
      // Bornés des DEUX côtés : `make_interval(secs => $1::int)` refuse tout ce qui dépasse un entier signé
      // 32 bits (`value out of range for type integer`, vérifié contre la base le 2026-09-03 en passant un
      // âge de cent ans). Aucun appelant sain n'en approche, mais une fonction qui lève sur son argument est
      // une fonction qu'on ne peut pas régler sans la relire.
      [borner(ageSecondes), borner(limite), sortie],
    );
    return res.rows.map((r) => ({
      sessionId: r.id, tenantId: r.tenant_id, runId: r.run_id, waId: r.wa_id, nodeId: r.node_id,
      // `coalesce` côté SQL plutôt qu'un repli côté TypeScript : le `returning` d'un UPDATE rend la valeur
      // d'APRÈS écriture, donc une session encore `en_cours` relit exactement la sortie forcée qu'on vient de
      // lui poser, et une session déjà close rend la sienne. Un point de décision en moins à tenir ici.
      sortie: r.sortie,
    }));
  }

  /**
   * La consommation de cet agent sur une fenetre glissante.
   *
   * ⚠️ Elle est bornee dans le TEMPS et jamais depuis toujours : `agent_sessions_tenant_idx` porte
   * `(tenant_id, created_at desc)`, donc une fenetre sert l'index. Un total « depuis le debut » obligerait a
   * relire toutes les sessions de l'espace a chaque ouverture d'ecran, pour un chiffre qui ne dit rien de
   * l'usage courant.
   *
   * ⚠️ `agent_id` est dans le `where` mais PAS dans l'index : la fenetre borne deja le balayage, et poser un
   * index par agent pour un ecran d'administration serait payer une ecriture sur le chemin chaud pour une
   * lecture rare. A revoir le jour ou un espace aura des dizaines de milliers de sessions par mois.
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
}
