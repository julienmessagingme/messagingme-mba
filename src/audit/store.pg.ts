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
  | 'cle_api.revoquee'
  /**
   * LES PORTES VERS L'EXTÉRIEUR (2026-09-16, lot 2 du même plan). Deux familles, et elles vont dans des sens
   * OPPOSÉS : le plan les avait confondues sous « webhooks sortants », relevé en lisant le code.
   *
   * 🔴 UN WEBHOOK EST UNE PORTE D'ENTRÉE, PAS UNE SORTIE. C'est une adresse que NOUS exposons et qu'un tiers
   * appelle : la créer ouvre un canal par lequel des contacts entrent dans l'espace, et une campagne « au fil
   * de l'eau » peut s'en nourrir. Le risque n'est pas l'exfiltration, c'est l'INGESTION par quelqu'un qui
   * connaît l'adresse, et la SUPPRESSION, qui tarit une campagne vivante.
   *
   * 🔴 UN CONNECTEUR EST LA SORTIE. Il porte l'adresse du système du client et son secret : c'est par lui que
   * des données quittent l'espace, et c'est lui que l'agent de Meta appellera EN DIRECT. Changer son adresse
   * change la destination de tout ce qui part.
   *
   * ⚠️ `webhook.secret_change` COUVRE LA POSE ET LE RETRAIT, sans les distinguer. Ce qui compte pour
   * l'exploitation est qu'on a touché à l'authentification de cette porte ; `detail.pose` dit lequel des deux,
   * sans inventer deux actions dont personne ne lirait la différence.
   */
  | 'webhook.cree'
  | 'webhook.modifie'
  | 'webhook.supprime'
  | 'webhook.secret_change'
  | 'connecteur.cree'
  | 'connecteur.modifie'
  | 'connecteur.supprime'
  | 'numero.connecte'
  /** Le numéro a été ACTIVÉ depuis la console (vérification par code si besoin, puis register Cloud API). */
  | 'numero.active'
  | 'contact.exporte'
  /**
   * LA CONNEXION PUBLICITAIRE (2026-09-23, lot 2 des publicités Click-to-WhatsApp).
   *
   * 🔴 ELLE APPARTIENT À LA MÊME FAMILLE QUE `connecteur.cree` : ce geste pose chez nous un JETON qui
   * permet de dépenser l'argent du client chez Meta, et de mettre ses publicités en pause. Savoir QUI a
   * connecté, QUI a choisi le compte et QUI a déconnecté est la première question qu'on posera le jour où
   * une pub aura tourné sans qu'on s'y attende.
   *
   * ⚠️ LE DÉTAIL NE PORTE NI LE JETON NI SON EMPREINTE, seulement des identifiants Meta et des COMPTES
   * (combien de comptes publicitaires, combien de Pages). Même règle que pour l'inscription WhatsApp.
   */
  | 'pubs.connectee'
  | 'pubs.actifs_choisis'
  | 'pubs.deconnectee'
  /**
   * 🔴 CRÉER ET PUBLIER SONT DEUX LIGNES DISTINCTES, ET LA SECONDE EST CELLE QUI COMPTE. Créer ne dépense
   * rien : tout naît en pause chez Meta. PUBLIER met la campagne en diffusion, donc engage le budget du
   * client sur son propre compte. Les fondre en une seule ligne rendrait impossible de répondre à « qui a
   * décidé que cette campagne dépenserait, et quand », qui est exactement la question qu'on posera le jour
   * où un montant surprendra quelqu'un.
   */
  | 'pubs.creee'
  | 'pubs.publiee'
  /**
   * ⚠️ LA PAUSE EST UN GESTE D'EXPLOITATION, et elle se trace au même titre que la publication : c'est
   * souvent le geste qu'on cherche à dater quand un client demande « pourquoi ma campagne s'est arrêtée ».
   */
  | 'pubs.pausee'
  | 'pubs.reprise';

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

/**
 * LES CLÉS QU'UN `detail` N'A PAS LE DROIT DE PORTER (2026-09-16, lot 3).
 *
 * 🔴 POURQUOI UNE GARDE MÉCANIQUE ET PAS UNE CONVENTION. La règle « détail non identifiant » est écrite dans
 * la migration 0061 et respectée par les dix-neuf points d'écriture d'aujourd'hui, vérifié un par un. Mais
 * c'est une convention : le vingtième l'ignorera, et personne ne le verra, parce qu'écrire un email de plus
 * ne casse rien et ne remonte nulle part. Or cette table n'est JAMAIS purgée par la rétention des contacts :
 * une donnée personnelle qui y entre devient ineffaçable, et annule l'effacement qu'une autre ligne du même
 * journal certifie.
 *
 * 🔴 COMPARAISON SUR LA CLÉ EXACTE, JAMAIS EN SOUS-CHAÎNE, et ce n'est pas un détail d'implémentation :
 * `emailSent` (déjà écrit par l'invitation) contient « email » sans être une donnée personnelle. Une garde en
 * sous-chaîne l'aurait effacé en silence, c'est-à-dire aurait cassé une trace utile au nom de la protection
 * d'une donnée absente.
 *
 * ⚠️ `name` N'EST PAS DANS LA LISTE, délibérément. Le libellé d'un webhook ou d'une clé d'API n'est pas une
 * personne, et l'interdire empêcherait de tracer ce qu'on vient de nommer. Ce qui est interdit, ce sont les
 * identités : l'adresse, le numéro, le contenu d'un message.
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
 * Retire du `detail` ce qui ne doit pas s'y trouver, et DIT ce qu'il a retiré.
 *
 * 🔴 ON FILTRE, ON NE REFUSE PAS. Lever ferait perdre la ligne d'audit entière : on échangerait une donnée
 * personnelle de trop contre une trace manquante, ce qui est pire pour exactement la même raison.
 *
 * 🔴 ET LE RETRAIT EST VISIBLE (`__refuses`), parce qu'une transformation silencieuse est un piège : celui
 * qui vient d'écrire `email` doit apprendre que ça n'a pas été gardé, sinon il croira sa trace complète.
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
    /**
     * 🔴 LE FILTRE EST ICI, AU POINT DE PASSAGE UNIQUE, ET NULLE PART AILLEURS. Les dix-neuf appelants
     * passent tous par cette méthode : la poser plus haut (dans `makeJournal`, ou pire dans chaque route)
     * ferait dix-neuf endroits où l'oublier, et le vingtième appelant ne l'aurait pas.
     */
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
