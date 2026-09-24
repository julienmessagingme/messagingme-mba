import type { Pool } from 'pg';
import { MATCH_BY_WAID_SQL } from '../crm/contact-store.pg';
import type { AnalyseDuSignal } from './types';
import type { FicheDuSignal, LecturesSignal } from './completer';

/**
 * Les lectures des signaux, en Postgres. `tenant_id = $1` sur CHAQUE requête : la connexion passe par le pooler
 * en rôle superuser, la RLS est contournée, ce filtre est le seul contrôle (`tests/signaux-isolation.test.ts`).
 */
interface LigneFiche {
  id: string;
  external_id: string | null;
  opt_in_status: string;
  opt_in_source: string | null;
  rcs_optout_at: Date | null;
}
const COLONNES_FICHE = 'id, external_id, opt_in_status, opt_in_source, rcs_optout_at';

function fiche(r: LigneFiche): FicheDuSignal {
  return {
    contactId: r.id,
    externalId: r.external_id,
    optOutWhatsapp: r.opt_in_status === 'opted_out',
    optOutRcs: r.rcs_optout_at !== null,
    optInSource: r.opt_in_source,
  };
}

export class PgSignauxStore implements LecturesSignal {
  constructor(private readonly pool: Pool) {}

  /** Par `wa_id` : numéro (avec ou sans `+`) ou BSUID, par le fragment PARTAGÉ du dépôt, jamais recopié. */
  async ficheParWaId(tenantId: string, waId: string): Promise<FicheDuSignal | null> {
    const res = await this.pool.query<LigneFiche>(
      `select ${COLONNES_FICHE} from contacts
        where tenant_id = $1 and deleted_at is null
        ${MATCH_BY_WAID_SQL}`,
      [tenantId, waId],
    );
    return res.rows[0] ? fiche(res.rows[0]) : null;
  }

  async ficheParId(tenantId: string, contactId: string): Promise<FicheDuSignal | null> {
    const res = await this.pool.query<LigneFiche>(
      `select ${COLONNES_FICHE} from contacts where tenant_id = $1 and id = $2 and deleted_at is null`,
      [tenantId, contactId],
    );
    return res.rows[0] ? fiche(res.rows[0]) : null;
  }

  async waIdDeLaConversation(tenantId: string, conversationId: string): Promise<string | null> {
    const res = await this.pool.query<{ wa_id: string }>(
      `select wa_id from conversations where tenant_id = $1 and id = $2`,
      [tenantId, conversationId],
    );
    return res.rows[0]?.wa_id ?? null;
  }

  /**
   * L'origine d'un message sortant et l'envoi auquel il appartient. Trois sous-requêtes sur clé, chacune servie
   * par son index (`conversation_messages_wamid_uidx`, `campaign_recipients_message_id_idx`,
   * `campaign_envois_message_id_idx`), chacune filtrée sur l'espace par sa jointure.
   *
   * 🔴 `campaign_envois` EN REPLI, ET IL N'EST PAS FACULTATIF. `campaign_recipients.message_id` ne garde que la
   * DERNIÈRE tentative d'un destinataire (0134) : l'accusé d'un étage PRÉCÉDENT d'une chaîne de repli (le
   * WhatsApp en échec avant le RCS, ou délivré tard) n'y est plus, et rendrait `sendId` à `null`. Le journal des
   * tentatives, lui, les garde toutes.
   */
  async contexteDuMessage(tenantId: string, messageId: string): Promise<{ origine: string | null; sendId: string | null }> {
    const res = await this.pool.query<{ origine: string | null; send_id: string | null }>(
      `select
         (select m.origin from conversation_messages m join conversations c on c.id = m.conversation_id
           where c.tenant_id = $1 and m.meta_message_id = $2 limit 1) as origine,
         coalesce(
           (select r.campaign_id from campaign_recipients r join campaigns k on k.id = r.campaign_id
             where k.tenant_id = $1 and r.message_id = $2 limit 1),
           (select e.campaign_id from campaign_envois e join campaigns ke on ke.id = e.campaign_id
             where ke.tenant_id = $1 and e.message_id = $2 limit 1)
         ) as send_id`,
      [tenantId, messageId],
    );
    const r = res.rows[0];
    return { origine: r?.origine ?? null, sendId: r?.send_id ?? null };
  }

  async lien(tenantId: string, code: string): Promise<{ template: string | null; destination: string } | null> {
    const res = await this.pool.query<{ template_name: string | null; destination: string }>(
      `select template_name, destination from tracked_links where tenant_id = $1 and code = lower($2)`,
      [tenantId, code],
    );
    const r = res.rows[0];
    return r ? { template: r.template_name, destination: r.destination } : null;
  }

  async analyse(tenantId: string, conversationId: string): Promise<AnalyseDuSignal | null> {
    const res = await this.pool.query<{
      intent: string; sentiment: string; satisfaction: number | null; urgence: number | null; resolved: boolean;
      topic: string; action_suggestion: string; handled_by: string; exchanges_count: number; summary: string | null;
    }>(
      `select intent, sentiment, satisfaction, urgence, resolved, topic, action_suggestion, handled_by,
              exchanges_count, summary
         from conversation_analysis where tenant_id = $1 and conversation_id = $2`,
      [tenantId, conversationId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      intent: r.intent,
      sentiment: r.sentiment,
      satisfaction: r.satisfaction,
      urgence: r.urgence,
      resolved: r.resolved,
      topic: r.topic,
      actionSuggestion: r.action_suggestion,
      handledBy: r.handled_by,
      exchangesCount: r.exchanges_count,
      summary: r.summary,
    };
  }
}
