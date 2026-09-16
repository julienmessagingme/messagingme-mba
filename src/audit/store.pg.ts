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
  | 'conversation.effacee'
  /**
   * LES ACCÈS (2026-09-15, lot 1 du plan `2026-09-15-audit-des-actions-sensibles.md`).
   *
   * 🔴 CE QUE CE GROUPE AJOUTE, ET POURQUOI C'ÉTAIT LE PREMIER TROU. Les sept actions du dessus tracent ce
   * qui touche aux PERSONNES ; aucune ne tracait ce qui donne du POUVOIR. Personne ne pouvait dire qui avait
   * nommé un admin, créé une clé d'API, ou révoqué un compte. C'est la première question d'un questionnaire
   * sécurité, et la réponse était « on ne sait pas ».
   *
   * 🔴 AUCUNE MIGRATION NE LES BORNE : `audit_log.action` est un `text` LIBRE (0061), sans CHECK. Ce type est
   * donc la SEULE garde contre une faute de frappe, et une action mal orthographiée s'écrirait en base sans
   * que rien ne proteste, puis manquerait à l'écran pour toujours.
   *
   * ⚠️ `numero.deconnecte` N'EXISTE PAS, et c'est un constat : aucune route ne détache un numéro aujourd'hui.
   * La déclarer produirait une action que rien n'écrit, c'est-à-dire le motif « offert-et-inerte ».
   */
  | 'utilisateur.invite'
  | 'utilisateur.role_change'
  | 'utilisateur.desactive'
  | 'utilisateur.retire'
  /**
   * ⚠️ UNIQUEMENT SUR UN COMPTE QUI EXISTE, et c'est une limite de CONCEPTION, pas un oubli.
   * `audit_log.tenant_id` est NOT NULL et référence `tenants` : une tentative sur une adresse inconnue
   * n'appartient à aucun espace et n'a donc nulle part où s'écrire. L'écran devra le DIRE, sans quoi on y
   * lira « aucune tentative » alors qu'il y en a eu.
   */
  | 'connexion.echouee'
  | 'cle_api.creee'
  | 'cle_api.revoquee';

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

  /**
   * Historique d'un espace, du plus récent au plus ancien, avec une RECHERCHE.
   *
   * 🔴 CE QU'ON PEUT CHERCHER, ET CE QU'ON NE PEUT PAS. Le journal ne porte AUCUNE donnée personnelle : ni
   * numéro, ni nom, ni texte (migration 0061). Chercher « par numéro de client », comme Julien l'a demandé,
   * n'est donc pas une recherche dans ce journal mais une RÉSOLUTION préalable : le numéro désigne un contact,
   * et c'est son identifiant interne qu'on cherche ici. Deux conséquences que l'écran doit dire plutôt que de
   * rendre une liste vide :
   *  - un numéro inconnu ne trouve rien, parce qu'aucun contact ne lui correspond ;
   *  - un contact ANONYMISÉ ne se retrouve plus par son numéro, puisque celui-ci a été détruit. C'est le
   *    comportement voulu du droit à l'effacement, pas un défaut de la recherche.
   *
   * `q` cherche dans ce qui est NON personnel : l'action, l'email de l'acteur, et l'identifiant de la cible.
   * `ilike` et non `to_tsvector` : la table est petite, les valeurs sont des identifiants et des mots-clés
   * techniques, et un index de texte intégral y serait de la mécanique pour rien.
   */
  async list(
    tenantId: string,
    opts: { limit?: number; targetId?: string; q?: string; acteur?: string; telephone?: string } = {},
  ): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const where = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const ajouter = (fragment: (n: number) => string, valeur: unknown): void => {
      params.push(valeur);
      where.push(fragment(params.length));
    };
    if (opts.targetId) ajouter((n) => `target_id = $${n}`, opts.targetId);
    if (opts.acteur) ajouter((n) => `actor_email ilike '%' || $${n} || '%'`, opts.acteur);
    if (opts.q) ajouter((n) => `(action ilike '%' || $${n} || '%' or actor_email ilike '%' || $${n} || '%' or target_id ilike '%' || $${n} || '%')`, opts.q);
    // Le NUMÉRO se résout en identifiants de contacts, dans la même requête : un aller-retour préalable
    // laisserait une fenêtre où le contact disparaît entre la résolution et la lecture.
    if (opts.telephone) {
      ajouter(
        (n) => `target_id in (select c.id::text from contacts c where c.tenant_id = $1
                   and (c.phone_e164 ilike '%' || $${n} || '%' or c.bsuid ilike '%' || $${n} || '%'))`,
        opts.telephone,
      );
    }
    params.push(limit);
    const res = await this.pool.query<Ligne>(
      `select id, at, actor_email, action, target_kind, target_id, detail
         from audit_log where ${where.join(' and ')} order by at desc limit $${params.length}`,
      params,
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
