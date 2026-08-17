import type { Pool } from 'pg';
import type { InboxStore, InboundMessage } from '../webhooks/inbound';

/**
 * Qui détient la conversation, et donc qui répond au client.
 *
 * `app_workflow` est le SEUL état qui autorise un scénario à avancer ou à démarrer. `mba` n'est jamais
 * déduit d'une de nos actions : il vient exclusivement d'un webhook `messaging_handovers`.
 */
export type ControlOwner = 'app_workflow' | 'app_human' | 'mba';

/**
 * Que devient un fil après une prise en main opérateur, au moment où le sweep de handback voudrait le rendre
 * au scénario (C.4). `resume` = rendu au scénario (comportement historique). `inbox` = reste à l'humain,
 * visible dans « À traiter », jamais rendu automatiquement. Réglé par tenant (défaut) et/ou par conversation
 * (surcharge). L'absence de choix (null en base) retombe sur le repli usine `resume`.
 */
export type ReturnBehavior = 'resume' | 'inbox';

export interface ConversationSummary {
  id: string;
  waId: string;
  profileName: string | null;
  lastPreview: string | null;
  lastMessageAt: string;
  controlOwner: ControlOwner;
  /** Un message ENTRANT est arrivé depuis la dernière ouverture du fil par un opérateur. */
  unread: boolean;
}
export interface ConversationMessage {
  id: string;
  direction: 'in' | 'out';
  type: string | null;
  body: string | null;
  buttonPayload: string | null;
  createdAt: string;
  /** Auteur d'un message sortant (name sinon partie locale de l'email). null = pas d'auteur (legacy/auto).
   *  Optionnel : les mocks de test qui omettent le champ restent valides. */
  senderName?: string | null;
}

/**
 * « Non lu » = il existe un message ENTRANT plus récent que la dernière ouverture du fil (`last_read_at`
 * null = jamais ouvert). Seul l'ENTRANT compte : nos propres envois (campagne, scénario) ne doivent pas
 * rallumer le compteur, sinon il s'allumerait tout seul à chaque campagne.
 *
 * Fragment SQL partagé par la liste et le compteur : deux écritures divergeraient au premier ajustement,
 * et la pastille afficherait un nombre que la liste ne montre pas. `c` = alias de `conversations`.
 */
const UNREAD_SQL = `exists (
  select 1 from conversation_messages m
  where m.conversation_id = c.id and m.direction = 'in'
    and m.created_at > coalesce(c.last_read_at, to_timestamp(0))
)`;

/** Store Postgres de la boîte de réception (conversations + messages). */
export class PgInboxStore implements InboxStore {
  constructor(private readonly pool: Pool) {}

  async phoneNumberTenant(phoneNumberId: string): Promise<string | null> {
    const res = await this.pool.query<{ tenant_id: string }>(
      `select tenant_id from phone_numbers where id = $1`,
      [phoneNumberId],
    );
    return res.rows[0]?.tenant_id ?? null;
  }

  /**
   * Upsert la conversation par (tenant, wa_id), lie le contact si son identité correspond, avance last_message_at +
   * last_preview, renvoie l'id. Le wa_id est en chiffres nus (numéro) OU un BSUID : on tente '+wa_id' (E.164 exact),
   * PUIS les seuls chiffres (tolère un formatage différent), PUIS le bsuid (contact sans numéro). Partagé par
   * l'inbound (webhook) et les envois sortants automatisés (campagne / workflow) -> même conversation, jamais de
   * doublon.
   */
  private async upsertConversationByWaId(tenantId: string, waId: string, preview: string): Promise<string> {
    const conv = await this.pool.query<{ id: string }>(
      // UN contact = UNE conversation, quel que soit le canal : c'est le MESSAGE qui porte son canal
      // (`conversation_messages.channel`, migration 0056), pas le fil. L'unique (tenant_id, wa_id) de 0009
      // reste donc l'arbitre de ce ON CONFLICT, et la reprise de main par un opérateur continue de valoir
      // pour le contact entier, pas pour un tuyau.
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, last_preview)
       values ($1, $2, (select id from contacts where tenant_id = $1
           and (phone_e164 = '+' || $2 or regexp_replace(phone_e164, '[^0-9]', '', 'g') = $2 or bsuid = $2)
         order by (phone_e164 = '+' || $2) desc limit 1), now(), $3)
       on conflict (tenant_id, wa_id) do update set
         last_message_at = now(),
         last_preview = excluded.last_preview,
         contact_id = coalesce(conversations.contact_id, excluded.contact_id),
         -- Un nouveau message ROUVRE l'analyse : une conversation déjà analysée (done/failed) qui reçoit un message
         -- redevient 'pending' -> ré-analysée à la prochaine inactivité (sinon un contact qui revient n'est jamais réanalysé).
         analysis_status = case when conversations.analysis_status in ('done', 'failed') then 'pending' else conversations.analysis_status end
       returning id`,
      [tenantId, waId, preview],
    );
    return conv.rows[0]!.id;
  }

  /**
   * Détenteur courant du fil. L'ABSENCE de conversation vaut `app_workflow` : une campagne peut viser un
   * contact qui n'a jamais écrit, sa conversation n'existe alors pas encore et rien ne doit être bloqué.
   */
  async getControlOwner(tenantId: string, waId: string): Promise<ControlOwner> {
    const res = await this.pool.query<{ control_owner: ControlOwner }>(
      `select control_owner from conversations where tenant_id = $1 and wa_id = $2`,
      [tenantId, waId],
    );
    return res.rows[0]?.control_owner ?? 'app_workflow';
  }

  /**
   * Pose le détenteur du fil.
   *
   * `only` restreint la transition aux détenteurs courants listés. C'est LE mécanisme qui empêche un envoi
   * automatisé de révoquer un opérateur engagé : sans lui, un opérateur répond à 10h00, une campagne
   * programmée touche le même contact à 10h02 et repose `app_workflow`, et le scénario redémarre par-dessus
   * l'humain au message suivant. La garde est DANS le WHERE, donc évaluée atomiquement, sans lecture
   * préalable et donc sans course entre la lecture et l'écriture.
   *
   * UPDATE SEUL, volontairement : ne crée jamais la conversation. Si la ligne n'existe pas, le détenteur
   * vaut déjà `app_workflow` (défaut de la colonne ET valeur rendue par `getControlOwner`), donc une pose
   * automatisée n'aurait rien à écrire ; et créer une conversation vide juste pour porter un état la ferait
   * apparaître sans le moindre message dans l'inbox. Les deux poses non automatiques (un humain qui répond,
   * un handover Meta) portent par construction sur une conversation qui a déjà des messages.
   *
   * Renvoie true si la bascule a eu lieu, false si la garde l'a refusée ou si l'état était déjà celui visé
   * (cas normaux, jamais une erreur).
   */
  async setControlOwner(
    tenantId: string,
    waId: string,
    owner: ControlOwner,
    opts?: { only?: readonly ControlOwner[] },
  ): Promise<boolean> {
    const only = opts?.only;
    const res = await this.pool.query(
      `update conversations set control_owner = $3, control_changed_at = now()
       where tenant_id = $1 and wa_id = $2
         and control_owner is distinct from $3
         and ($4::text[] is null or control_owner = any($4::text[]))`,
      [tenantId, waId, owner, only ? [...only] : null],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * TOUTES les conversations dont le contrôle est détenu (hors `app_workflow`), les plus anciennes d'abord.
   *
   * Alimente le garde-fou d'inactivité : il n'existe AUCUN release automatique côté Meta, donc un contrôle
   * jamais rendu (opérateur parti, onglet fermé, crash) gèlerait la conversation indéfiniment.
   *
   * AUCUN filtre d'âge en SQL, volontairement : le délai de reprise est réglable PAR CLIENT, et un client
   * peut choisir un délai plus court que le défaut du serveur. Filtrer ici avec le défaut raterait
   * silencieusement ses conversations. Le tri est donc fait en SQL, la décision en mémoire, avec le
   * réglage du bon client. Un état détenu est transitoire par construction, donc ce lot reste petit ; si
   * le plafond était atteint, ce sont les plus anciennes qui passent d'abord, ce qui est la bonne priorité.
   *
   * `control_changed_at` null = bascule d'avant la migration 0040 : traitée comme éligible, sinon ces
   * conversations resteraient bloquées pour toujours.
   */
  async listHeldControl(
    limit = 500,
  ): Promise<Array<{ tenantId: string; waId: string; owner: ControlOwner; changedAt: Date | null; returnBehavior: ReturnBehavior | null }>> {
    const res = await this.pool.query<{ tenant_id: string; wa_id: string; control_owner: ControlOwner; control_changed_at: Date | null; return_behavior: ReturnBehavior | null }>(
      // `return_behavior` (surcharge par conversation, C.4) descend avec le lot : le sweep en a besoin pour
      // décider, sans requête par conversation, si un fil humain doit rester à l'inbox plutôt qu'être rendu.
      `select tenant_id, wa_id, control_owner, control_changed_at, return_behavior
       from conversations
       where control_owner <> 'app_workflow'
       order by control_changed_at nulls first
       limit $1`,
      [limit],
    );
    return res.rows.map((r) => ({
      tenantId: r.tenant_id,
      waId: r.wa_id,
      owner: r.control_owner,
      changedAt: r.control_changed_at,
      returnBehavior: r.return_behavior === 'inbox' || r.return_behavior === 'resume' ? r.return_behavior : null,
    }));
  }

  /**
   * Surcharge par conversation de la destination de reprise (C.4). `null` retire la surcharge -> le fil suit
   * le défaut du tenant. UPDATE ciblé par (tenant, wa_id) : ne crée jamais de conversation vide.
   */
  async setConversationReturnBehavior(tenantId: string, waId: string, behavior: ReturnBehavior | null): Promise<void> {
    await this.pool.query(
      `update conversations set return_behavior = $3 where tenant_id = $1 and wa_id = $2`,
      [tenantId, waId, behavior],
    );
  }

  /**
   * Marque le fil comme une conversation de TEST (jeton de test d'un scénario, Lot F). Sens unique : une
   * conversation née d'un test le reste, ses messages de test y sont pour toujours. Exclut le fil de l'analyse
   * (donc du push HubSpot par construction) et des statistiques, pour qu'un essai interne ne soit pas compté
   * comme un vrai client dans le tableau de bord.
   *
   * UPDATE SEUL : le message entrant qui porte le jeton a déjà créé la conversation (`recordInbound` tourne
   * avant), donc il n'y a jamais rien à créer ici.
   */
  async markConversationTest(tenantId: string, waId: string): Promise<void> {
    await this.pool.query(
      `update conversations set is_test = true where tenant_id = $1 and wa_id = $2 and not is_test`,
      [tenantId, waId],
    );
  }

  async recordInbound(tenantId: string, m: InboundMessage): Promise<void> {
    const preview = m.body ?? m.buttonPayload ?? `[${m.type}]`;
    const conversationId = await this.upsertConversationByWaId(tenantId, m.waId, preview);
    await this.pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, button_payload, meta_message_id)
       values ($1, 'in', $2, $3, $4, $5)
       on conflict (meta_message_id) where meta_message_id is not null do nothing`,
      [conversationId, m.type, m.body, m.buttonPayload, m.messageId],
    );
  }

  /**
   * Journalise un envoi sortant AUTOMATISÉ (template de campagne ou de workflow) par wa_id : upsert la conversation
   * + insère le message 'out' avec `sender_user_id = null` (pas un humain -> pas de pastille agent). Idempotent sur
   * `meta_message_id`. Sans ça, les envois campagne/workflow n'apparaissaient PAS dans le fil d'inbox et manquaient
   * au transcript d'analyse. À appeler en BEST-EFFORT côté appelant (un échec de log ne doit pas casser l'envoi Meta).
   */
  async recordOutboundByWaId(
    tenantId: string,
    waId: string,
    msg: { body: string; messageId: string | null; type?: string; templateCategory?: string | null; templateName?: string | null },
  ): Promise<void> {
    const conversationId = await this.upsertConversationByWaId(tenantId, waId, msg.body);
    await this.pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, template_category, template_name, sender_user_id)
       values ($1, 'out', $2, $3, $4, $5, $6, null)
       on conflict (meta_message_id) where meta_message_id is not null do nothing`,
      [conversationId, msg.type ?? 'template', msg.body, msg.messageId, msg.templateCategory ?? null, msg.templateName ?? null],
    );
  }

  async listConversations(tenantId: string): Promise<ConversationSummary[]> {
    const res = await this.pool.query<{
      id: string; wa_id: string; profile_name: string | null; last_preview: string | null; last_message_at: Date;
      control_owner: ControlOwner; unread: boolean;
    }>(
      `select c.id, c.wa_id, ct.profile_name, c.last_preview, c.last_message_at, c.control_owner,
              ${UNREAD_SQL} as unread
       from conversations c
       left join contacts ct on ct.id = c.contact_id
       where c.tenant_id = $1
       order by c.last_message_at desc
       limit 100`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      waId: r.wa_id,
      profileName: r.profile_name,
      lastPreview: r.last_preview,
      lastMessageAt: r.last_message_at.toISOString(),
      controlOwner: r.control_owner,
      unread: r.unread,
    }));
  }

  /** Nombre de conversations NON LUES du tenant (pastille du menu). Requête dédiée : le menu est monté sur
   *  toutes les pages, il ne doit pas rapatrier 100 conversations pour afficher un nombre. */
  async countUnread(tenantId: string): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      `select count(*)::text as n from conversations c where c.tenant_id = $1 and ${UNREAD_SQL}`,
      [tenantId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /**
   * Marque un fil comme LU (un opérateur vient de l'ouvrir). Scopé au tenant : un id de conversation d'un
   * autre workspace ne marque rien. Idempotent.
   */
  async markConversationRead(tenantId: string, conversationId: string): Promise<void> {
    await this.pool.query(
      `update conversations set last_read_at = now() where id = $1 and tenant_id = $2`,
      [conversationId, tenantId],
    );
  }

  /**
   * Contexte pour répondre : wa_id + état de la fenêtre de service 24 h. La fenêtre est ouverte
   * si le DERNIER message ENTRANT (du client) a moins de 24 h. Hors fenêtre -> texte libre
   * interdit par Meta (131047), il faut un template. null si conversation absente/autre tenant.
   */
  async getConversationContext(
    conversationId: string,
    tenantId: string,
  ): Promise<{ waId: string; lastInboundAt: string | null; windowOpen: boolean; returnBehavior: ReturnBehavior | null } | null> {
    const res = await this.pool.query<{ wa_id: string; last_in: Date | null; return_behavior: ReturnBehavior | null }>(
      `select c.wa_id, c.return_behavior, max(m.created_at) filter (where m.direction = 'in') as last_in
       from conversations c
       left join conversation_messages m on m.conversation_id = c.id
       where c.id = $1 and c.tenant_id = $2
       group by c.wa_id, c.return_behavior`,
      [conversationId, tenantId],
    );
    const r = res.rows[0];
    if (!r) return null;
    const lastIn = r.last_in;
    const windowOpen = !!lastIn && Date.now() - lastIn.getTime() < 24 * 3600 * 1000;
    const returnBehavior = r.return_behavior === 'inbox' || r.return_behavior === 'resume' ? r.return_behavior : null;
    return { waId: r.wa_id, lastInboundAt: lastIn ? lastIn.toISOString() : null, windowOpen, returnBehavior };
  }

  /**
   * Fenêtre de service 24 h pour un LOT de wa_id (cible node de /v1/sends, D-1). Même règle que
   * `getConversationContext` : dernier message ENTRANT strictement < 24 h. Un wa_id sans conversation, ou avec
   * une conversation mais aucun inbound, est ABSENT de la map -> l'appelant le traite comme fermé
   * (`.get()` -> undefined -> falsy). Une seule requête pour tout le lot (pas de N+1).
   */
  async getWindowOpenByWaIds(tenantId: string, waIds: string[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    if (waIds.length === 0) return out;
    const res = await this.pool.query<{ wa_id: string; last_in: Date | null }>(
      `select c.wa_id, max(m.created_at) filter (where m.direction = 'in') as last_in
       from conversations c
       left join conversation_messages m on m.conversation_id = c.id
       where c.tenant_id = $1 and c.wa_id = any($2::text[])
       group by c.wa_id`,
      [tenantId, waIds],
    );
    for (const r of res.rows) {
      if (!r.last_in) continue; // aucun inbound -> fenêtre jamais ouverte, on laisse absent
      out.set(r.wa_id, Date.now() - r.last_in.getTime() < 24 * 3600 * 1000);
    }
    return out;
  }

  async getMessages(conversationId: string): Promise<ConversationMessage[]> {
    const res = await this.pool.query<{
      id: string; direction: 'in' | 'out'; type: string | null; body: string | null; button_payload: string | null; created_at: Date; sender_name: string | null;
    }>(
      // sender_name : name du user, sinon la partie locale de son email ; null si pas d'auteur (legacy/auto).
      `select m.id, m.direction, m.type, m.body, m.button_payload, m.created_at,
              coalesce(nullif(u.name, ''), split_part(u.email, '@', 1)) as sender_name
       from conversation_messages m
       left join users u on u.id = m.sender_user_id
       where m.conversation_id = $1 order by m.created_at limit 500`,
      [conversationId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      direction: r.direction,
      type: r.type,
      body: r.body,
      buttonPayload: r.button_payload,
      createdAt: r.created_at.toISOString(),
      senderName: r.sender_name,
    }));
  }

  /** Journalise une réponse sortante de l'agent (texte libre ou template). Pour un template,
   *  `templateCategory` (marketing|utility) + `templateName` alimentent les stats du dashboard.
   *  `senderUserId` (EN FIN de signature) = auteur -> pastille dans l'inbox ; null pour les réponses auto. */
  async recordOutbound(
    conversationId: string,
    body: string,
    messageId: string | null,
    type = 'text',
    templateCategory: string | null = null,
    templateName: string | null = null,
    senderUserId: string | null = null,
  ): Promise<void> {
    await this.pool.query(
      `update conversations set last_message_at = now(), last_preview = $2,
         analysis_status = case when analysis_status in ('done', 'failed') then 'pending' else analysis_status end
       where id = $1`,
      [conversationId, body],
    );
    await this.pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, template_category, template_name, sender_user_id)
       values ($1, 'out', $4, $2, $3, $5, $6, $7)`,
      [conversationId, body, messageId, type, templateCategory, templateName, senderUserId],
    );
  }
}
