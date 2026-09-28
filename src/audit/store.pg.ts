import type { Pool } from 'pg';

/**
 * Journal d'audit des actions sensibles.
 *
 * 🔴 En ajout seul : ce store n'expose ni update ni delete. Un journal modifiable ne prouve rien.
 * 🔴 Aucune donnée personnelle n'y entre : l'identifiant interne du contact, jamais son numéro ni son nom. Écrire le
 * numéro au moment d'une purge réinscrirait la personne dans une table faite pour ne jamais être modifiée.
 */

export type AuditAction =
  | 'contact.created'
  | 'contact.imported'
  | 'contact.purged'
  | 'contact.optin'
  | 'contact.optout'
  // Mise en ligne d'un scénario : `workflows` ne garde que la date de publication, qui a cliqué est ici.
  | 'workflow.published'
  /**
   * Effacement du contenu d'une conversation, irréversible : il ferme aussi la fenêtre de 24 h (calculée sur les
   * entrants), ce que l'écran doit annoncer. La ligne ne porte que l'identifiant interne et le nombre de messages.
   */
  | 'conversation.effacee'
  /**
   * Les accès : qui a nommé un admin, créé une clé d'API ou révoqué un compte.
   * `audit_log.action` est un `text` libre, sans CHECK : ce type est la seule garde contre une faute de frappe, qui
   * s'écrirait en base puis manquerait à l'écran pour toujours. Pas de `numero.deconnecte` : aucune route ne détache
   * un numéro, l'action ne serait jamais écrite.
   */
  | 'utilisateur.invite'
  | 'utilisateur.role_change'
  | 'utilisateur.desactive'
  | 'utilisateur.retire'
  /**
   * Uniquement sur un compte qui existe : `audit_log.tenant_id` est NOT NULL, une tentative sur une adresse inconnue
   * n'a nulle part où s'écrire. L'écran doit le dire, sinon on y lirait « aucune tentative ».
   */
  | 'connexion.echouee'
  | 'cle_api.creee'
  | 'cle_api.revoquee'
  /**
   * Les portes vers l'extérieur, en deux familles de sens opposés.
   * Un webhook est une porte d'entrée que nous exposons : le risque est l'ingestion par qui connaît l'adresse, et la
   * suppression, qui tarit une campagne vivante. Un connecteur est la sortie : il porte l'adresse du système du
   * client et son secret, changer son adresse change la destination de tout ce qui part.
   * `webhook.secret_change` couvre pose et retrait ; `detail.pose` dit lequel.
   */
  | 'webhook.cree'
  | 'webhook.modifie'
  | 'webhook.supprime'
  | 'webhook.secret_change'
  | 'connecteur.cree'
  | 'connecteur.modifie'
  | 'connecteur.supprime'
  | 'numero.connecte'
  /** Le numéro a été activé depuis la console (vérification par code si besoin, puis register Cloud API). */
  | 'numero.active'
  /**
   * Le numéro a été délié puis relié depuis l'Accueil : rien n'est détaché chez Meta ni supprimé chez nous. La cible
   * est l'espace (le geste porte sur tous ses numéros), le détail ne porte que des comptes de campagnes.
   */
  | 'numero.delie'
  | 'numero.relie'
  | 'contact.exporte'
  /**
   * La connexion publicitaire : ce geste pose un jeton qui permet de dépenser l'argent du client chez Meta. Qui a
   * connecté, choisi le compte ou déconnecté est la première question le jour où une pub tourne sans qu'on s'y
   * attende. Le détail ne porte ni le jeton ni son empreinte, seulement des identifiants Meta et des comptes.
   */
  | 'pubs.connectee'
  | 'pubs.actifs_choisis'
  | 'pubs.deconnectee'
  /**
   * Créer et publier sont deux lignes : créer ne dépense rien (tout naît en pause chez Meta), publier engage le
   * budget du client. C'est la seconde qui répond à « qui a décidé que cette campagne dépenserait, et quand ».
   */
  | 'pubs.creee'
  | 'pubs.publiee'
  /** La pause se trace aussi : c'est souvent le geste qu'on cherche à dater (« pourquoi ma campagne s'est arrêtée »). */
  | 'pubs.pausee'
  | 'pubs.reprise'
  | 'pubs.archivee'
  | 'pubs.desarchivee'
  /**
   * Le branchement d'un outil qui reçoit les signaux : par lui, des données de contacts quittent l'espace. Le détail
   * ne porte jamais les clés, et ni lui ni la cible ne nomment l'outil (ce journal est un écran de la marque).
   */
  | 'integration.branchee'
  | 'integration.modifiee'
  | 'integration.debranchee'
  /**
   * L'APP SALESFORCE (plan 2026-09-26, lot L1). Ces actions NOMMENT l'outil (décision de Julien du 2026-09-26 : le
   * journal nomme l'outil) : relier une org fait sortir des données de contacts vers le système du client, et
   * l'admin doit pouvoir lire lequel. Le détail ne porte jamais le secret de l'org : l'org et le genre (sandbox),
   * les noms des champs de consentement, l'option du résumé.
   */
  | 'salesforce.allumee'
  | 'salesforce.eteinte'
  | 'salesforce.connectee'
  | 'salesforce.modifiee'
  | 'salesforce.deconnectee'
  /**
   * L'espace renommé. Détail vide, ni l'ancien nom ni le nouveau : un nom d'espace peut être l'identité d'une
   * personne (« Espace de Jean Dupont »), et l'écrire sous une autre clé que `nom` contournerait `CLES_INTERDITES`.
   */
  | 'espace.renomme'
  /**
   * Le second facteur. Il appartient à l'identité : chaque ligne est écrite dans chaque espace de la personne, sous
   * son compte de cet espace.
   * 🔴 Le détail ne porte jamais le code ni le secret, seulement l'étape. `mfa.echec` s'écrit sans être attendu,
   * comme `connexion.echouee` : attendre ferait varier la durée de réponse selon l'existence d'une ligne.
   * `mfa.reinitialise` porte l'admin qui a agi (ou aucun acteur, depuis l'exploitation) et vise le membre.
   */
  | 'mfa.active'
  | 'mfa.code_secours_utilise'
  | 'mfa.echec'
  | 'mfa.reinitialise'
  | 'mfa.codes_regeneres'
  | 'mfa.desactive';

export interface AuditEntry {
  id: string;
  at: string;
  actorEmail: string | null;
  action: AuditAction;
  targetKind: string;
  targetId: string;
  detail: Record<string, unknown>;
}

/** Qui agit. `null` = le système (balayage, worker, webhook), pas un humain. */
export interface AuditActor {
  userId: string | null;
  email: string | null;
}

/**
 * Les clés qu'un `detail` n'a pas le droit de porter.
 *
 * 🔴 Une garde mécanique, pas une convention : cette table n'est jamais purgée par la rétention des contacts, et
 * une donnée personnelle qui y entre devient ineffaçable.
 * Comparaison sur la clé exacte, jamais en sous-chaîne : `emailSent` contient « email » sans être une donnée
 * personnelle. `name` n'est pas dans la liste : le libellé d'un webhook ou d'une clé n'est pas une personne.
 */
export const CLES_INTERDITES = new Set([
  'email', 'mail', 'e_mail', 'emails',
  'phone', 'phonee164', 'phone_e164', 'telephone', 'tel', 'numero', 'number', 'msisdn',
  'waid', 'wa_id', 'recipient', 'recipient_id',
  'body', 'text', 'texte', 'contenu', 'message', 'messages_texte',
  'nom', 'prenom', 'profilename', 'profile_name', 'displayphonenumber', 'display_phone_number',
  'adresse', 'address',
]);

/**
 * Retire du `detail` ce qui ne doit pas s'y trouver, et dit ce qu'il a retiré (`__refuses`). On filtre sans lever :
 * lever ferait perdre la ligne d'audit entière, et un retrait silencieux ferait croire la trace complète.
 */
export function detailSansDonneesPersonnelles(
  detail: Record<string, unknown>,
): { detail: Record<string, unknown>; refuses: string[] } {
  const refuses: string[] = [];
  const propre: Record<string, unknown> = {};
  for (const [cle, valeur] of Object.entries(detail)) {
    if (CLES_INTERDITES.has(cle.toLowerCase())) refuses.push(cle);
    else propre[cle] = valeur;
  }
  return refuses.length === 0 ? { detail: propre, refuses } : { detail: { ...propre, __refuses: refuses }, refuses };
}

export class PgAuditStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Écrit une entrée. Best-effort côté appelant : un journal en échec ne doit jamais faire échouer l'action qu'il
   * observe. L'appelant attrape et journalise l'échec en console.
   */
  async record(
    tenantId: string,
    actor: AuditActor,
    action: AuditAction,
    target: { kind: string; id: string },
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    // Le filtre est ici, au point de passage unique : plus haut, chaque appelant serait un endroit où l'oublier.
    const propre = detailSansDonneesPersonnelles(detail);
    if (propre.refuses.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`audit ${action} : champ(s) NON journalisé(s) car identifiant(s) : ${propre.refuses.join(', ')}`);
    }
    await this.pool.query(
      `insert into audit_log (tenant_id, actor_user_id, actor_email, action, target_kind, target_id, detail)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, actor.userId, actor.email, action, target.kind, target.id, JSON.stringify(propre.detail)],
    );
  }

  /**
   * Historique d'un espace, du plus récent au plus ancien, avec une recherche.
   *
   * Le journal ne porte aucune donnée personnelle : chercher par numéro est une résolution préalable du numéro en
   * contacts. Un numéro inconnu ne trouve donc rien, et un contact anonymisé ne se retrouve plus par son numéro
   * (droit à l'effacement) : l'écran doit le dire.
   * `q` cherche dans ce qui est non personnel (action, email de l'acteur, identifiant de la cible), en `ilike` : la
   * table est petite et ses valeurs sont des identifiants.
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
    // Le numéro se résout en contacts dans la même requête : un aller-retour préalable laisserait une fenêtre où le
    // contact disparaît entre la résolution et la lecture.
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
   * Purge les entrées plus vieilles que la rétention. Ce journal ne porte aucune donnée personnelle : la purge répond
   * à la croissance, pas au RGPD.
   * 🔴 Rétention longue (deux ans par défaut) : ce journal prouve qu'une purge a eu lieu et qui l'a demandée, le
   * raccourcir effacerait l'attestation en gardant l'obligation.
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
