import type { Pool } from 'pg';

/**
 * Historique d'un contact : ce qu'on lui a ENVOYÉ, et ce qu'il a ÉCHANGÉ avec nous.
 *
 * Store de LECTURE uniquement, séparé du store d'écriture des contacts (même découpage que
 * `src/stats/conversation-stats.pg.ts` face à `src/analysis/store.pg.ts`).
 *
 * Deux règles de jointure, différentes, et c'est le cœur du sujet :
 *
 *  - les ENVOIS se relient par `campaign_recipients.contact_id`, jamais par le numéro. `to_e164` est figé à la
 *    construction de la campagne : si le contact change de numéro ensuite, une correspondance par numéro rate
 *    tout son passé. (`getCampaignFunnel` joint bien par `to_e164`, mais c'est un funnel de campagne, pas un
 *    historique de personne : ce serait un bug ici.)
 *
 *  - les CONVERSATIONS ne peuvent PAS se relier par `contact_id` seul. Cette colonne est nullable et posée en
 *    `coalesce` dans `upsertConversationByWaId` : une conversation ouverte AVANT que le contact existe garde
 *    `contact_id` null jusqu'au message suivant. S'en tenir à `contact_id` perdrait ces échanges EN SILENCE.
 *    On rattrape donc par `wa_id`, en recopiant la règle d'identité de l'inbox : le numéro en chiffres nus, et
 *    le BSUID brut. Un contact peut porter les deux, donc plusieurs conversations : on renvoie une liste.
 */

export interface ContactSend {
  campaignId: string;
  campaignName: string;
  category: string;
  /** null quand la campagne envoie un scénario au lieu d'un template (migration 0024). */
  templateName: string | null;
  templateLanguage: string | null;
  /** Nom du scénario envoyé, quand il n'y a pas de template. */
  workflowName: string | null;
  /** Statut du destinataire : pending | sending | sent | failed | skipped. */
  status: string;
  sentAt: string | null;
  error: string | null;
  /**
   * Dernier état de livraison connu : sent < delivered < read, ou failed. NULL sur un envoi parfaitement
   * réussi dont le webhook de statut n'est jamais arrivé : cela veut dire « statut inconnu », JAMAIS
   * « non délivré ». Il n'existe aucun horodatage par étape, seulement celui du dernier changement.
   */
  deliveryStatus: string | null;
  deliveryUpdatedAt: string | null;
  /**
   * La personne a-t-elle RÉAGI à cet envoi : répondu, appuyé sur un bouton, ou CLIQUÉ sur un lien du message.
   *
   * 🔴 Ce n'est PAS « lu ». « Lu » dit que Meta a affiché le message ; « engagé » dit qu'un humain a fait
   * quelque chose. Un message peut être lu par milliers sans qu'une seule personne ne réagisse, et c'est
   * précisément l'écart que cet indicateur rend visible.
   *
   * ⚠️ LE CLIC A ÉTÉ AJOUTÉ LE 2026-09-02, ET IL COMBLAIT UN TROU RÉEL. Un bouton URL fait SORTIR le contact
   * de la conversation : il n'en revient aucun message entrant, donc la personne la plus engagée de la
   * campagne, celle qui a ouvert le lien, s'affichait comme n'ayant pas réagi. C'est aussi ce qui rend enfin
   * VISIBLE l'attribution des clics (migrations 0106 et 0107) : sans elle, on saurait qui a cliqué sans
   * jamais le montrer nulle part.
   *
   * Bornes : après l'envoi, avant le prochain envoi à ce contact, et dans les 24 h. La première borne évite
   * que deux campagnes du même jour se créditent l'une l'autre ; la seconde évite de compter une réponse de
   * la semaine suivante comme une réaction à ce message-là.
   */
  engage: boolean;
}

export interface ContactConversationAnalysis {
  sentiment: string;
  intent: string;
  topic: string;
  resolved: boolean;
  handledBy: string;
  exchangesCount: number;
  actionSuggestion: string;
  /** Date de la DERNIÈRE analyse (upsert sur la clé primaire), pas la date de la conversation. */
  analyzedAt: string;
}

export interface ContactConversation {
  conversationId: string;
  waId: string;
  lastMessageAt: string;
  lastPreview: string | null;
  messagesCount: number;
  /** pending | queued | done | failed. */
  analysisStatus: string;
  analysis: ContactConversationAnalysis | null;
  /**
   * true quand une analyse EXISTE mais qu'un message est arrivé depuis (le statut est retombé hors 'done').
   * Sans ce drapeau, l'interface afficherait une analyse périmée comme si elle était fraîche.
   */
  analysisStale: boolean;
  /** Lien vers le fil complet dans l'inbox. Les messages ne sont PAS embarqués ici (voir le commentaire bas). */
  inboxHref: string;
}

export interface ContactHistory {
  sends: ContactSend[];
  conversations: ContactConversation[];
}

/** Bornes de lecture : un historique d'écran, pas un export. Au-delà, l'inbox et le détail de campagne. */
const MAX_SENDS = 200;
const MAX_CONVERSATIONS = 100;
/** Borne HAUTE de l'export CSV (F5) : bien au-delà d'un écran, mais bornée pour ne pas ramener un volume illimité. */
const EXPORT_MAX_SENDS = 5000;

export class PgContactHistoryStore {
  constructor(private readonly pool: Pool) {}

  /** null si le contact n'existe pas pour ce tenant (la route en fait un 404, jamais une liste vide trompeuse). */
  async getContactHistory(tenantId: string, contactId: string): Promise<ContactHistory | null> {
    // Le contact est chargé D'ABORD, scopé tenant : c'est lui qui distingue « aucun historique » (listes vides,
    // réponse 200) de « ce contact n'est pas à toi » (404). Sans ce contrôle, un id d'un autre tenant
    // renverrait deux listes vides, c'est-à-dire un 200 rassurant sur une ressource interdite.
    const owner = await this.pool.query<{ id: string }>(
      `select id from contacts where id = $1 and tenant_id = $2`,
      [contactId, tenantId],
    );
    if (!owner.rows[0]) return null;

    const [sends, conversations] = await Promise.all([
      this.listSends(tenantId, contactId, MAX_SENDS),
      this.listConversations(tenantId, contactId),
    ]);
    return { sends, conversations };
  }

  /**
   * LA MATIÈRE DU BILAN D'UN CONTACT : ses envois par catégorie (pour le coût), et la profondeur atteinte
   * parcours par parcours (pour l'entonnoir). Demande de Julien du 2026-09-11.
   *
   * 🔴 UN PARCOURS = UN ENVOI DE CAMPAGNE, BORNÉ COMME `engage` L'EST DÉJÀ : jusqu'au prochain envoi, et au
   * plus 24 h. Ce n'est pas un choix de confort, c'est la seule borne cohérente avec le reste de la fiche.
   * Sans elle, mesuré sur les données réelles, le dernier parcours avalait toute la conversation qui suit et
   * rendait des « niveaux » 27 et 35 : une discussion racontée comme un entonnoir.
   *
   * 🔴 SEULS LES SORTANTS AUTOMATIQUES COMPTENT COMME SOLLICITATION (`sender_user_id is null`). Un opérateur
   * qui écrit depuis l'Inbox ne fait pas avancer un scénario d'un cran : compter ses messages ferait grimper
   * le niveau d'un contact au seul motif qu'on a discuté avec lui, ce qui est l'inverse de ce que l'entonnoir
   * mesure.
   *
   * ⚠️ UNE RÉACTION EST UN ENTRANT **OU** UN CLIC ATTRIBUÉ, exactement la définition d'`engage` un peu plus
   * haut, appliquée en profondeur : « cliqué ou répondu, bref il y a eu un engagement » (Julien). Un bouton
   * de réponse rapide arrive comme un entrant portant son `button_payload`, donc il compte ; un bouton URL
   * fait SORTIR le contact de la conversation, d'où le second test.
   *
   * ⚠️ La profondeur est un `max`, pas un compte : le niveau ATTEINT est le plus profond, et c'est
   * `entonnoirEngagement` qui en fait un cumul « au moins N ».
   */
  async bilanContact(tenantId: string, contactId: string): Promise<{ envois: Array<{ category: string | null; count: number }>; profondeurs: number[] } | null> {
    const owner = await this.pool.query<{ id: string }>(
      `select id from contacts where id = $1 and tenant_id = $2`,
      [contactId, tenantId],
    );
    if (!owner.rows[0]) return null;

    const [volumes, profondeurs] = await Promise.all([
      this.pool.query<{ category: string | null; count: string }>(
        `select c.category, count(*)::bigint as count
           from campaign_recipients r join campaigns c on c.id = r.campaign_id
          where r.contact_id = $2 and c.tenant_id = $1 and r.sent_at is not null
          group by c.category`,
        [tenantId, contactId],
      ),
      this.pool.query<{ niveau: string }>(
        `with parcours as (
           select r.sent_at as debut,
                  lead(r.sent_at) over (order by r.sent_at) as fin
             from campaign_recipients r join campaigns c on c.id = r.campaign_id
            where r.contact_id = $2 and c.tenant_id = $1 and r.sent_at is not null
         ),
         sollicitations as (
           select p.debut, m.created_at,
                  row_number() over (partition by p.debut order by m.created_at, m.id) as rang,
                  lead(m.created_at) over (partition by p.debut order by m.created_at, m.id) as suivante
             from parcours p
             join conversations cv on cv.tenant_id = $1 and cv.contact_id = $2
             join conversation_messages m on m.conversation_id = cv.id
            where m.direction = 'out'
              and m.sender_user_id is null
              and m.created_at >= p.debut
              and m.created_at < least(coalesce(p.fin, 'infinity'::timestamptz), p.debut + interval '24 hours')
         ),
         touchees as (
           select s.debut, s.rang
             from sollicitations s
            where exists (
               select 1 from conversation_messages m2 join conversations cv2 on cv2.id = m2.conversation_id
                where cv2.tenant_id = $1 and cv2.contact_id = $2 and m2.direction = 'in'
                  and m2.created_at > s.created_at
                  and m2.created_at < least(coalesce(s.suivante, 'infinity'::timestamptz), s.created_at + interval '24 hours'))
               or exists (
               select 1 from tracked_link_clicks tc
                where tc.tenant_id = $1 and tc.contact_id = $2
                  and tc.at > s.created_at
                  and tc.at < least(coalesce(s.suivante, 'infinity'::timestamptz), s.created_at + interval '24 hours'))
         )
         select max(rang)::bigint as niveau from touchees group by debut`,
        [tenantId, contactId],
      ),
    ]);
    return {
      envois: volumes.rows.map((r) => ({ category: r.category, count: Number(r.count) })),
      profondeurs: profondeurs.rows.map((r) => Number(r.niveau)),
    };
  }

  /**
   * Envois d'un contact pour l'EXPORT CSV (F5) : mêmes lignes que l'historique d'écran mais SANS le cap 200 (borné à
   * EXPORT_MAX_SENDS par sûreté, log si atteint). null si le contact n'appartient pas au tenant (404 côté route, pas
   * une liste vide trompeuse sur une ressource interdite). Lecture seule, scopée tenant en SQL.
   */
  async listSendsForExport(tenantId: string, contactId: string): Promise<ContactSend[] | null> {
    const owner = await this.pool.query<{ id: string }>(
      `select id from contacts where id = $1 and tenant_id = $2`,
      [contactId, tenantId],
    );
    if (!owner.rows[0]) return null;
    const sends = await this.listSends(tenantId, contactId, EXPORT_MAX_SENDS);
    if (sends.length >= EXPORT_MAX_SENDS) {
      // eslint-disable-next-line no-console
      console.warn(JSON.stringify({ lvl: 'warn', msg: 'contact_history_export_truncated', tenantId, contactId, limit: EXPORT_MAX_SENDS }));
    }
    return sends;
  }

  private async listSends(tenantId: string, contactId: string, limit: number): Promise<ContactSend[]> {
    const res = await this.pool.query<{
      campaign_id: string; name: string; category: string;
      template_name: string | null; template_language: string | null; workflow_name: string | null;
      status: string; sent_at: Date | null; error: string | null;
      delivery_status: string | null; delivery_updated_at: Date | null; engage: boolean;
    }>(
      // `c.tenant_id = $1` en plus du contrôle d'appartenance du contact : double barrière assumée, la même
      // que dans conversation-stats.pg.ts. Une campagne d'un autre tenant ne peut pas remonter ici.
      //
      // 🔴 `engage` : la personne a-t-elle RÉAGI à cet envoi ? Demandé par Julien le 2026-09-02, « en plus de
      // l'indicateur Lu, Engagé, ce qui montre que la personne a au moins réagi ou a appuyé quelque part dans
      // le template envoyé ». « Lu » dit que Meta a affiché le message ; « engagé » dit qu'un humain a fait
      // quelque chose, ce qui n'est pas la même information et n'a pas la même valeur.
      //
      // DEUX BORNES, et chacune corrige une façon de mentir :
      //  - la borne HAUTE de 24 h, parce qu'une réponse trois jours plus tard n'est pas une réaction à ce
      //    message-là ; c'est aussi la fenêtre de service, donc la seule pendant laquelle la personne peut
      //    répondre librement ;
      //  - le PROCHAIN ENVOI, parce que deux campagnes le même jour se créditeraient l'une l'autre : une
      //    réponse arrivée après le second message ne dit rien du premier.
      //
      // Tout message ENTRANT compte, texte comme appui de bouton : un appui arrive comme un entrant portant
      // son `button_payload`, et exiger un payload exclurait « oui » écrit à la main, qui est pourtant la
      // même réaction.
      //
      // 🔴 ET LE CLIC SUR UN LIEN, depuis le 2026-09-02. Un bouton URL fait SORTIR le contact de la
      // conversation : il n'en revient aucun entrant, donc sans ce second test la personne qui a ouvert le
      // lien, la plus engagée de la campagne, s'affichait comme n'ayant pas réagi. Les MÊMES bornes que la
      // réponse, et pour les mêmes raisons.
      //
      // ⚠️ Ne remontent ici que les clics ATTRIBUÉS (`contact_id` non nul), c'est-à-dire ceux dont l'URL
      // portait le jeton du destinataire. Les liens des templates approuvés avant le 2026-09-02 ont une
      // adresse figée chez Meta, sans jeton : leurs clics restent anonymes et ne peuvent créditer personne.
      // C'est une limite physique, pas un oubli, et Julien l'a arbitrée : « on s'en fout des vieux templates ».
      `with envois as (
         select r.contact_id, r.status, r.sent_at, r.error, r.delivery_status, r.delivery_updated_at,
                c.id as campaign_id, c.name, c.category, c.template_name, c.template_language, c.created_at,
                w.name as workflow_name,
                lead(r.sent_at) over (order by r.sent_at) as prochain_envoi
           from campaign_recipients r
             join campaigns c on c.id = r.campaign_id
             left join workflows w on w.id = c.workflow_id
          where r.contact_id = $2 and c.tenant_id = $1
       )
       select e.campaign_id, e.name, e.category, e.template_name, e.template_language, e.workflow_name,
              e.status, e.sent_at, e.error, e.delivery_status, e.delivery_updated_at,
              (e.sent_at is not null and (exists (
                 select 1
                   from conversation_messages m
                   join conversations cv on cv.id = m.conversation_id
                  where cv.tenant_id = $1 and cv.contact_id = e.contact_id
                    and m.direction = 'in'
                    and m.created_at > e.sent_at
                    and m.created_at < least(coalesce(e.prochain_envoi, 'infinity'::timestamptz),
                                             e.sent_at + interval '24 hours')
              ) or exists (
                 select 1
                   from tracked_link_clicks tc
                  where tc.tenant_id = $1 and tc.contact_id = e.contact_id
                    and tc.at > e.sent_at
                    and tc.at < least(coalesce(e.prochain_envoi, 'infinity'::timestamptz),
                                      e.sent_at + interval '24 hours')
              ))) as engage
         from envois e
        order by e.sent_at desc nulls last, e.created_at desc
        limit ${limit}`,
      [tenantId, contactId],
    );
    return res.rows.map((r) => ({
      campaignId: r.campaign_id,
      campaignName: r.name,
      category: r.category,
      templateName: r.template_name,
      templateLanguage: r.template_language,
      workflowName: r.workflow_name,
      status: r.status,
      sentAt: r.sent_at ? r.sent_at.toISOString() : null,
      error: r.error,
      deliveryStatus: r.delivery_status,
      deliveryUpdatedAt: r.delivery_updated_at ? r.delivery_updated_at.toISOString() : null,
      engage: r.engage,
    }));
  }

  private async listConversations(tenantId: string, contactId: string): Promise<ContactConversation[]> {
    const res = await this.pool.query<{
      id: string; wa_id: string; last_message_at: Date; last_preview: string | null;
      analysis_status: string; messages_count: string;
      sentiment: string | null; intent: string | null; topic: string | null; resolved: boolean | null;
      handled_by: string | null; exchanges_count: number | null; action_suggestion: string | null;
      analyzed_row_at: Date | null;
    }>(
      // Les identités possibles du contact sont dérivées EN SQL, jamais reçues du client : accepter un wa_id
      // envoyé par le front ouvrirait la lecture des conversations de n'importe qui.
      // `array_remove` deux fois : un contact n'a pas forcément les deux identités, et un `phone_e164` vide
      // donnerait une chaîne vide qui ne doit surtout pas servir de critère.
      `with ct as (
         select id,
                nullif(regexp_replace(coalesce(phone_e164, ''), '[^0-9]', '', 'g'), '') as digits,
                nullif(bsuid, '') as bsuid
         from contacts where id = $2 and tenant_id = $1
       )
       select c.id, c.wa_id, c.last_message_at, c.last_preview, c.analysis_status,
              (select count(*) from conversation_messages m where m.conversation_id = c.id)::text as messages_count,
              ca.sentiment, ca.intent, ca.topic, ca.resolved, ca.handled_by, ca.exchanges_count,
              ca.action_suggestion, ca.created_at as analyzed_row_at
       from conversations c
         cross join ct
         left join conversation_analysis ca on ca.conversation_id = c.id
       where c.tenant_id = $1
         and (c.contact_id = ct.id or c.wa_id = any(array_remove(array[ct.digits, ct.bsuid], null)))
       order by c.last_message_at desc
       limit ${MAX_CONVERSATIONS}`,
      [tenantId, contactId],
    );
    return res.rows.map((r) => {
      const analysis: ContactConversationAnalysis | null =
        r.analyzed_row_at && r.sentiment !== null
          ? {
              sentiment: r.sentiment,
              intent: r.intent ?? '',
              topic: r.topic ?? '',
              resolved: r.resolved ?? false,
              handledBy: r.handled_by ?? '',
              exchangesCount: r.exchanges_count ?? 0,
              actionSuggestion: r.action_suggestion ?? '',
              analyzedAt: r.analyzed_row_at.toISOString(),
            }
          : null;
      return {
        conversationId: r.id,
        waId: r.wa_id,
        lastMessageAt: r.last_message_at.toISOString(),
        lastPreview: r.last_preview,
        messagesCount: Number(r.messages_count),
        analysisStatus: r.analysis_status,
        analysis,
        // Une analyse existe ET le statut est reparti hors 'done' -> un message est arrivé depuis.
        analysisStale: analysis !== null && r.analysis_status !== 'done',
        inboxHref: `/inbox?c=${r.id}`,
      };
    });
  }
}
