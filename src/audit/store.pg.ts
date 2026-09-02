import type { Pool } from 'pg';

/**
 * Journal d'audit des actions sensibles sur les contacts.
 *
 * En AJOUT SEUL : ce store n'expose ni update ni delete, et c'est la seule garantie qui compte. Un journal
 * modifiable ne prouve rien, il ne fait que déplacer la question de la confiance.
 *
 * ⚠️ Aucune donnée personnelle n'y entre. Le journal porte l'identifiant INTERNE du contact, jamais son numéro
 * ni son nom. Écrire le numéro au moment d'une purge annulerait la purge : on effacerait la personne d'un côté
 * pour la réinscrire de l'autre, dans une table faite pour ne jamais être modifiée.
 */

export type AuditAction =
  | 'contact.created'
  | 'contact.imported'
  | 'contact.purged'
  | 'contact.optin'
  | 'contact.optout'
  // Mise en ligne d'un scénario (lot 7). La table `workflows` ne garde que la DATE de publication ; qui a
  // cliqué est ici, comme pour toute action humaine de l'espace.
  | 'workflow.published'
  /**
   * Effacement du CONTENU d'une conversation (2026-09-02). Irréversible, et il emporte une conséquence que
   * l'écran doit annoncer : la fenêtre de service de 24 h se calcule sur les messages ENTRANTS, donc effacer
   * le fil la ferme, et on ne peut plus répondre librement à ce contact.
   *
   * ⚠️ Comme toute ligne de ce journal, elle ne porte NI le numéro NI le texte des messages : seulement
   * l'identifiant interne de la conversation et le nombre de messages effacés. Y écrire le contenu
   * annulerait l'effacement qu'on vient de faire, dans une table conçue pour ne jamais être modifiée.
   */
  | 'conversation.effacee';

export interface AuditEntry {
  id: string;
  at: string;
  actorEmail: string | null;
  action: AuditAction;
  targetKind: string;
  targetId: string;
  detail: Record<string, unknown>;
}

/** Qui agit. `null` = le système (sweeper, worker, webhook), pas un humain. */
export interface AuditActor {
  userId: string | null;
  email: string | null;
}

export class PgAuditStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Écrit une entrée. BEST-EFFORT côté appelant : un journal en échec ne doit jamais faire échouer l'action
   * métier qu'il observe, sinon une panne d'écriture de log bloquerait la suppression d'un contact. L'appelant
   * est responsable d'attraper, et de journaliser l'échec en console pour qu'il reste visible.
   */
  async record(
    tenantId: string,
    actor: AuditActor,
    action: AuditAction,
    target: { kind: string; id: string },
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await this.pool.query(
      `insert into audit_log (tenant_id, actor_user_id, actor_email, action, target_kind, target_id, detail)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, actor.userId, actor.email, action, target.kind, target.id, JSON.stringify(detail)],
    );
  }

  /** Historique d'un espace, du plus récent au plus ancien. Filtre optionnel sur une cible précise. */
  async list(
    tenantId: string,
    opts: { limit?: number; targetId?: string } = {},
  ): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const res = opts.targetId
      ? await this.pool.query<Ligne>(
          `select id, at, actor_email, action, target_kind, target_id, detail
             from audit_log where tenant_id = $1 and target_id = $2 order by at desc limit $3`,
          [tenantId, opts.targetId, limit],
        )
      : await this.pool.query<Ligne>(
          `select id, at, actor_email, action, target_kind, target_id, detail
             from audit_log where tenant_id = $1 order by at desc limit $2`,
          [tenantId, limit],
        );
    return res.rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actorEmail: r.actor_email,
      action: r.action as AuditAction,
      targetKind: r.target_kind,
      targetId: r.target_id,
      detail: r.detail ?? {},
    }));
  }

  /**
   * Purge les entrées plus vieilles que la rétention.
   *
   * ⚠️ Ce journal ne porte AUCUNE donnée personnelle, par construction (cf. migration 0061 : l'identifiant
   * interne du contact, jamais son numéro ni son nom). Ce balayage ne répond donc pas au RGPD mais à la
   * croissance : une ligne par action sur un contact, sans fin.
   *
   * 🔴 Et c'est pour ça que sa rétention est LONGUE. Ce journal est la PREUVE qu'une purge a eu lieu et de qui
   * l'a demandée ; le raccourcir revient à effacer l'attestation en gardant l'obligation. Deux ans par défaut.
   */
  async purgeOlderThan(days: number, maxParPassage = 50_000): Promise<number> {
    if (days <= 0) return 0;
    const res = await this.pool.query(
      `delete from audit_log
        where id in (select id from audit_log where at < now() - make_interval(days => $1) limit $2)`,
      [Math.floor(days), Math.max(1, maxParPassage)],
    );
    return res.rowCount ?? 0;
  }
}

interface Ligne {
  id: string;
  at: Date;
  actor_email: string | null;
  action: string;
  target_kind: string;
  target_id: string;
  detail: Record<string, unknown> | null;

}
