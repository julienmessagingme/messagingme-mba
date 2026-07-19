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
      this.listSends(tenantId, contactId),
      this.listConversations(tenantId, contactId),
    ]);
    return { sends, conversations };
  }

  private async listSends(tenantId: string, contactId: string): Promise<ContactSend[]> {
    const res = await this.pool.query<{
      campaign_id: string; name: string; category: string;
      template_name: string | null; template_language: string | null; workflow_name: string | null;
      status: string; sent_at: Date | null; error: string | null;
      delivery_status: string | null; delivery_updated_at: Date | null;
    }>(
      // `c.tenant_id = $1` en plus du contrôle d'appartenance du contact : double barrière assumée, la même
      // que dans conversation-stats.pg.ts. Une campagne d'un autre tenant ne peut pas remonter ici.
      `select c.id as campaign_id, c.name, c.category, c.template_name, c.template_language,
              w.name as workflow_name,
              r.status, r.sent_at, r.error, r.delivery_status, r.delivery_updated_at
       from campaign_recipients r
         join campaigns c on c.id = r.campaign_id
         left join workflows w on w.id = c.workflow_id
       where r.contact_id = $2 and c.tenant_id = $1
       order by r.sent_at desc nulls last, c.created_at desc
       limit ${MAX_SENDS}`,
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
