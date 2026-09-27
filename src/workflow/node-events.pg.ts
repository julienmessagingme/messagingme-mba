import type { Pool } from 'pg';

/**
 * Journal des événements par bloc d'un scénario (socle de « Analytics > Mes tableaux »).
 *
 * En ajout seul : ni update ni delete ici, l'agrégation se fait à la lecture. La seule écriture après coup est
 * l'anonymisation (purge d'un contact, rétention), qui remplace le `wa_id` par « anonyme » sans supprimer la
 * ligne : les compteurs restent justes et plus personne n'y est reconnaissable.
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
  /**
   * Contacts distincts, qui diffère de `count` dès qu'une personne clique deux fois. `null` quand la mesure ne
   * distingue pas les personnes (clics sur un lien de template, sans identité) : 0 dirait « personne n'a
   * cliqué » à côté de 40 clics.
   */
  contacts: number | null;
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
   * Rattache un accusé Meta (délivré / lu / échec) au bloc qui a envoyé ce message, en recopiant l'espace, le
   * scénario, le bloc et le destinataire depuis la ligne d'envoi (les statuts Meta ne connaissent que l'id).
   *
   * Idempotent par (message, nature) : Meta répète ses statuts. Un id qui n'appartient à aucun envoi de
   * scénario ne crée rien, puisque la méthode est appelée sur tous les statuts. Renvoie le nombre de lignes
   * créées (0 ou 1).
   */
  async recordStatusForMessage(metaMessageId: string, kind: 'delivered' | 'read' | 'failed'): Promise<number> {
    const res = await this.pool.query(
      `insert into workflow_node_events (tenant_id, workflow_id, node_id, wa_id, kind, meta_message_id)
       select tenant_id, workflow_id, node_id, wa_id, $2, meta_message_id
         from workflow_node_events
        where meta_message_id = $1 and kind = 'sent'
          and not exists (
            select 1 from workflow_node_events d where d.meta_message_id = $1 and d.kind = $2
          )
        limit 1`,
      [metaMessageId, kind],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Agrégat d'un scénario sur une période : par bloc, par nature, et par choix pour les clics, avec le nombre
   * de contacts distincts (« combien de clics » n'est pas « combien de personnes »). Les lignes anonymisées
   * comptent comme un contact : on ne sait plus les distinguer, et les exclure fausserait le total vers le bas.
   * Bornes inclusive à gauche, exclusive à droite, comme partout dans les stats.
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

  /**
   * Anonymise les événements de blocs plus vieux que la rétention, sans rien supprimer.
   *
   * 🔴 Ces lignes sont la mesure (aucune statistique rétroactive n'existe ailleurs) : les supprimer effacerait
   * l'historique des tableaux du client pour retirer un numéro. On retire le numéro et on garde le compteur,
   * comme pour la purge d'un contact et `campaign_recipients.to_e164`. Ce balayage ferme le risque RGPD, il ne
   * borne pas la croissance de la table (le jour venu : un pré-agrégat, pas une purge).
   *
   * Borné par passage : la première passe sur une table jamais balayée peut viser des millions de lignes.
   */
  async anonymiserAnciens(days: number, maxParPassage = 50_000): Promise<number> {
    if (days <= 0) return 0;
    const res = await this.pool.query(
      `update workflow_node_events set wa_id = 'anonyme'
        where id in (
          select id from workflow_node_events
           where at < now() - make_interval(days => $1) and wa_id <> 'anonyme'
           limit $2
        )`,
      [Math.floor(days), Math.max(1, maxParPassage)],
    );
    return res.rowCount ?? 0;
  }
}
