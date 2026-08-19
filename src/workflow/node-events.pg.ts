import type { Pool } from 'pg';

/**
 * Journal des ÉVÉNEMENTS PAR BLOC d'un scénario (socle de « Analytics > Mes tableaux »).
 *
 * En AJOUT SEUL : ni update ni delete ici. Un compteur qui se réécrit ne compte plus rien, et l'agrégation se
 * fait à la lecture, pas en entretenant des totaux qu'il faudrait garder justes.
 *
 * ⚠️ La seule écriture qui touche ces lignes après coup vit dans la PURGE d'un contact, qui remplace le `wa_id`
 * par « anonyme » sans supprimer la ligne : les compteurs d'un tableau restent justes après un effacement, et
 * plus personne n'y est reconnaissable. C'est la décision « on anonymise pour garder le quanti ».
 */
export type NodeEventKind = 'sent' | 'failed' | 'delivered' | 'read' | 'reply_button' | 'reply_text';

export interface NodeEvent {
  tenantId: string;
  workflowId: string;
  nodeId: string;
  waId: string;
  kind: NodeEventKind;
  /** Identifiant Meta du message envoyé (`sent`) : c'est lui qui rattachera plus tard un accusé de lecture. */
  metaMessageId?: string;
  /** `reply_button` : le handle du bouton choisi (`btn:<i>`, ou carte/bouton d'un carousel). */
  handle?: string;
}

/** Une ligne d'agrégat : pour ce bloc, cette nature (et ce choix), combien. */
export interface NodeEventCount {
  nodeId: string;
  kind: NodeEventKind;
  /** null hors `reply_button` : les autres natures n'ont pas de choix à distinguer. */
  handle: string | null;
  count: number;
  /** Contacts DISTINCTS, qui diffère de `count` dès qu'une personne clique deux fois. */
  contacts: number;
}

export class PgWorkflowNodeEventStore {
  constructor(private readonly pool: Pool) {}

  async record(e: NodeEvent): Promise<void> {
    await this.pool.query(
      `insert into workflow_node_events (tenant_id, workflow_id, node_id, wa_id, kind, meta_message_id, handle)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [e.tenantId, e.workflowId, e.nodeId, e.waId, e.kind, e.metaMessageId ?? null, e.handle ?? null],
    );
  }

  /**
   * Agrégat d'un scénario sur une période : par bloc, par nature, et par choix pour les clics.
   *
   * Rend AUSSI le nombre de contacts distincts. Les deux chiffres répondent à des questions différentes :
   * « combien de clics » n'est pas « combien de personnes », et un tableau qui les confond ment dès qu'un
   * contact clique deux fois. Les lignes anonymisées par une purge comptent comme UN contact, ce qui est le
   * moins faux : on ne sait plus les distinguer, et les exclure fausserait le total vers le bas.
   *
   * Bornes de période INCLUSIVE à gauche, EXCLUSIVE à droite, comme partout ailleurs dans les stats.
   */
  async countByNode(
    tenantId: string,
    workflowId: string,
    range: { from: string; to: string },
  ): Promise<NodeEventCount[]> {
    const res = await this.pool.query<{ node_id: string; kind: string; handle: string | null; n: string; c: string }>(
      `select node_id, kind, handle, count(*)::int as n, count(distinct wa_id)::int as c
         from workflow_node_events
        where tenant_id = $1 and workflow_id = $2
          and at >= $3::date and at < ($4::date + interval '1 day')
        group by node_id, kind, handle
        order by node_id, kind, handle`,
      [tenantId, workflowId, range.from, range.to],
    );
    return res.rows.map((r) => ({
      nodeId: r.node_id,
      kind: r.kind as NodeEventKind,
      handle: r.handle,
      count: Number(r.n),
      contacts: Number(r.c),
    }));
  }
}
