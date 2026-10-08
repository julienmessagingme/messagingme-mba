import type { Pool } from 'pg';
import { MATCH_BY_WAID_SQL } from '../crm/contact-store.pg';
import { COLONNES_ANALYSE_FICHE, analyseDeLaLigne, type LigneAnalyseFiche } from '../analysis/fiche';
import type { AnalyseDuSignal } from './types';
import type { FicheDuSignal, LecturesSignal } from './completer';

/**
 * 🔴 Les lectures des signaux, en Postgres. `tenant_id = $1` sur chaque requête : le pooler est en rôle
 * superuser, la RLS est contournée, ce filtre est le seul contrôle (`tests/signaux-isolation.test.ts`).
 */
type LigneFiche = {
  id: string;
  phone_e164: string | null;
  profile_name: string | null;
  external_id: string | null;
  opt_in_status: string;
  opt_in_source: string | null;
  rcs_optout_at: Date | null;
} & LigneAnalyseFiche;
// La dernière analyse se lit dans la MÊME requête que la fiche : aucune lecture de plus par signal.
const COLONNES_FICHE = `id, phone_e164, profile_name, external_id, opt_in_status, opt_in_source, rcs_optout_at, ${COLONNES_ANALYSE_FICHE.join(', ')}`;

function fiche(r: LigneFiche): FicheDuSignal {
  const a = analyseDeLaLigne(r);
  return {
    contactId: r.id,
    telephone: r.phone_e164,
    nom: r.profile_name,
    externalId: r.external_id,
    optOutWhatsapp: r.opt_in_status === 'opted_out',
    optOutRcs: r.rcs_optout_at !== null,
    optInSource: r.opt_in_source,
    derniereAnalyse: a === null ? null : {
      intent: a.intention, sentiment: a.sentiment, satisfaction: a.satisfaction, urgence: a.urgence, resolved: a.resolue,
      topic: a.sujet, handledBy: a.traiteePar, actionSuggestion: a.action,
    },
  };
}

export class PgSignauxStore implements LecturesSignal {
  constructor(private readonly pool: Pool) {}

  /** Par `wa_id` : numéro (avec ou sans `+`) ou BSUID, par le fragment partagé du dépôt, jamais recopié. */
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
   * par son index et filtrée sur l'espace par sa jointure.
   * `campaign_envois` en repli, indispensable : `campaign_recipients.message_id` ne garde que la dernière
   * tentative, donc l'accusé d'un étage précédent d'une chaîne de repli n'y est plus.
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
