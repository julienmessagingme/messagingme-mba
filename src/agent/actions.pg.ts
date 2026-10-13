import type { Pool } from 'pg';
import type { ReservationAction } from './actions';

/** Une action partie dans une conversation, telle que `get_conversation` la rend. */
export interface ActionDeLaConversation {
  /** L'outil qui porte l'action. */
  actionId: string;
  nom: string;
  at: string;
  champs: Record<string, unknown>;
}

/** Une action de l'espace, telle que le menu du déclencheur d'automation la propose. */
export interface ActionDeLEspace {
  /** L'outil qui porte l'action : la configuration du déclencheur le garde (`{ actionId }`). */
  id: string;
  nom: string;
  agentId: string;
  agent: string;
}

/**
 * Les actions de l'agent IA parties (`agent_actions`, migration 0232). 🔴 L'unicité du jour est tenue par la BASE
 * (`agent_actions_une_par_jour`, sur l'outil, le contact et le jour) : deux tours simultanés du même contact ne font
 * partir qu'une action, ce qu'une lecture suivie d'une écriture ne garantirait pas.
 */
export class PgActionsAgent {
  constructor(private readonly pool: Pool) {}

  /** L'identifiant de la ligne réservée, ou `null` si l'action est déjà partie ce jour-là pour ce contact. */
  async reserver(l: ReservationAction): Promise<string | null> {
    const res = await this.pool.query<{ id: string }>(
      `insert into agent_actions (tenant_id, tool_id, agent_id, conversation_id, wa_id, jour, champs)
       values ($1, $2, $3, $4, $5, $6::date, $7::jsonb)
       on conflict on constraint agent_actions_une_par_jour do nothing
       returning id`,
      [l.tenantId, l.actionId, l.agentId, l.conversationId, l.waId, l.jour, JSON.stringify(l.champs)],
    );
    return res.rows[0]?.id ?? null;
  }

  /**
   * Les actions posées sur les agents de l'espace, pour le menu du déclencheur d'automation « action de l'agent IA ».
   * 🔴 Filtré sur l'espace, l'agent joint dans le même espace. Le nom vient de la cible (`binding.nom`).
   */
  async listerDeLEspace(tenantId: string): Promise<ActionDeLEspace[]> {
    const res = await this.pool.query<ActionDeLEspace>(
      `select t.id, coalesce(t.binding->>'nom', t.name) as nom, a.id as "agentId", a.label as agent
         from agent_tools t
         join agents a on a.id = t.agent_id and a.tenant_id = t.tenant_id
        where t.tenant_id = $1 and t.origin = 'mba' and t.binding->>'handler' = 'declencher_action'
        order by a.label, nom`,
      [tenantId],
    );
    return res.rows;
  }

  /**
   * Les dernières actions parties dans une conversation, la plus récente d'abord (`get_conversation`). 🔴 Filtré sur
   * l'espace ; l'outil est joint dans le même espace. Servi par `agent_actions_conversation_idx`.
   */
  async listerDeLaConversation(tenantId: string, conversationId: string, limite: number): Promise<ActionDeLaConversation[]> {
    const res = await this.pool.query<{ actionId: string; nom: string; at: Date; champs: Record<string, unknown> }>(
      `select a.tool_id as "actionId", coalesce(t.binding->>'nom', t.name) as nom, a.at, a.champs
         from agent_actions a
         join agent_tools t on t.id = a.tool_id and t.tenant_id = a.tenant_id
        where a.tenant_id = $1 and a.conversation_id = $2
        order by a.at desc
        limit $3`,
      [tenantId, conversationId, limite],
    );
    return res.rows.map((r) => ({ actionId: r.actionId, nom: r.nom, at: r.at.toISOString(), champs: r.champs }));
  }

  /** Rend une réservation dont le webhook n'a pas pu s'écrire. Filtré sur l'espace. */
  async annuler(tenantId: string, reservationId: string): Promise<void> {
    await this.pool.query('delete from agent_actions where tenant_id = $1 and id = $2', [tenantId, reservationId]);
  }
}
