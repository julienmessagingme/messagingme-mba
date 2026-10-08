import type { Pool, PoolClient } from 'pg';
import { enTransaction } from '../db/transaction';
import { MATCH_BY_WAID_SQL } from '../crm/contact-store.pg';
import { waIdOf } from '../crm/identity';
import type { AnalysisContext } from './analyzer';
import type { AnalysisMessage } from './engine';
import type { ConversationAnalysis } from './schema';
import type { StoredConversationAnalysis } from './events';
import { analyseDeLaLigne, COLONNES_ANALYSE_FICHE, type CopieFiche, type LigneAnalyseFiche } from './fiche';

/** Une conversation réclamée pour analyse. */
export interface ClaimedConversation {
  conversationId: string;
  tenantId: string;
}

/**
 * Store Postgres de la passe d'analyse. Réclamation atomique (`pending` -> `queued`, FOR UPDATE SKIP LOCKED) pour
 * ne traiter chaque conversation qu'une fois malgré concurrence et rejeu. La conversation ne se ferme jamais : on
 * analyse l'épisode depuis `analyzed_at`.
 */
export class PgConversationAnalysisStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Réclame en lot les conversations inactives encore `pending` -> `queued`. Les fils de test sont exclus : ni analyse
   * LLM, ni poussée vers HubSpot.
   *
   * 🔴 L'ANALYSE EST ÉTEINTE EN BASE (lot 6, livraison C) : la conversation d'un espace en Base passe en `hors_offre`
   * au lieu de `queued`, l'offre lue en SQL (`offre_de_l_espace`, une fois par conversation), et n'est pas rendue. Un
   * nouveau message la remet en `pending` (`PgInboxStore`) ; passer en Pro n'analyse donc jamais le passé en rafale.
   */
  async claimForAnalysis(inactivityMs: number, limit: number): Promise<ClaimedConversation[]> {
    const res = await this.pool.query<{ id: string; tenant_id: string }>(
      `with candidates as (
         select id, tenant_id from conversations
          where analysis_status = 'pending' and not is_test and last_message_at < now() - make_interval(secs => $1 / 1000.0)
          order by last_message_at asc
          limit $2
          for update skip locked
       ),
       marquees as (
         update conversations c
            set analysis_status = case when o.offre = 'base' then 'hors_offre' else 'queued' end,
                analysis_queued_at = case when o.offre = 'base' then c.analysis_queued_at else now() end
           from candidates k, lateral (select offre_de_l_espace(k.tenant_id) as offre) o
          where c.id = k.id
          returning c.id, c.tenant_id, c.analysis_status
       )
       select id, tenant_id from marquees where analysis_status = 'queued'`,
      [inactivityMs, limit],
    );
    return res.rows.map((r) => ({ conversationId: r.id, tenantId: r.tenant_id }));
  }

  /** Ramène en `pending` les conversations bloquées en `queued` (worker mort en cours). Rend le nombre. */
  async reclaimStaleQueued(olderThanMs: number): Promise<number> {
    const res = await this.pool.query(
      `update conversations set analysis_status = 'pending'
       where analysis_status = 'queued' and analysis_queued_at < now() - make_interval(secs => $1 / 1000.0)`,
      [olderThanMs],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Relâche une conversation `queued` en `pending` (enfilement échoué, pas de job). Gardé sur
   * `analysis_status = 'queued'` : on ne piétine jamais une transition concurrente.
   */
  async reclaimQueued(conversationId: string): Promise<void> {
    await this.pool.query(
      `update conversations set analysis_status = 'pending' where id = $1 and analysis_status = 'queued'`,
      [conversationId],
    );
  }

  /**
   * Contexte d'analyse : messages depuis la dernière analyse (bornés) et signaux déterministes (humain = sortant
   * avec `sender_user_id`). null si la conversation n'existe plus.
   */
  async getContext(conversationId: string): Promise<AnalysisContext | null> {
    const conv = await this.pool.query<{ analyzed_at: Date | null }>(
      `select analyzed_at from conversations where id = $1`,
      [conversationId],
    );
    if ((conv.rowCount ?? 0) === 0) return null;
    // `created_at::text` : un Date JS tronque aux ms, la borne retomberait sous le dernier message et la
    // conversation serait réanalysée en boucle. La borne voyage donc en texte.
    const rows = await this.pool.query<{ direction: 'in' | 'out'; body: string | null; type: string | null; sender_user_id: string | null; created_at: string }>(
      // Une réponse écrite par Claude (origine mcp) n'est pas une réponse humaine, même signée de la personne qui
      // l'a autorisé (OAuth, lot 2) : elle se lit comme sans expéditeur, exactement comme avec une clé d'API.
      `select direction, body, type, case when origin = 'mcp' then null else sender_user_id end as sender_user_id,
              created_at::text as created_at from conversation_messages
       where conversation_id = $1 and created_at > coalesce((select analyzed_at from conversations where id = $1), '-infinity'::timestamptz)
       order by created_at asc, id asc
       limit 500`,
      [conversationId],
    );
    const messages: AnalysisMessage[] = rows.rows.map((r) => ({ direction: r.direction, body: r.body, type: r.type, senderUserId: r.sender_user_id }));
    const hasHumanOutbound = messages.some((m) => m.direction === 'out' && m.senderUserId != null);
    // Ordre ASC et limit 500 : le dernier lu est la borne de la fenêtre (au-delà de 500, le reste sera repris).
    const windowEnd = rows.rows.length > 0 ? rows.rows[rows.rows.length - 1]!.created_at : null;
    return { messages, signals: { hasHumanOutbound }, windowEnd };
  }

  /**
   * Persiste l'analyse (une ligne par conversation) et avance `analyzed_at` jusqu'à `windowEnd` (texte, précision
   * µs), jamais jusqu'à now() ; repasse en `pending` s'il reste des messages arrivés pendant l'analyse, sinon `done`.
   * Puis recopie l'analyse sur la fiche du contact (`copierSurLaFiche`) et rend ce qui a été recopié. En une
   * transaction : une copie qui échoue annule l'analyse, d'où la parité des CHECK tenue par
   * `tests/fiche-analyse-migration.test.ts`.
   */
  async save(conversationId: string, tenantId: string, a: ConversationAnalysis, model: { provider: string; model: string }, windowEnd: string | null): Promise<CopieFiche | null> {
    return enTransaction(this.pool, async (client) => {
      // `on conflict ... set tenant_id` n'est pas une réaffectation entre espaces : la clé est `conversation_id`, et
      // une conversation appartient à un seul espace, celui que reçoit save().
      await client.query(
        `insert into conversation_analysis
           (conversation_id, tenant_id, sentiment, intent, topic, resolved, handled_by, exchanges_count, entities,
            action_suggestion, confidence, justification, llm_provider, llm_model, abusive, summary,
            satisfaction, urgence)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         on conflict (conversation_id) do update set
           tenant_id = excluded.tenant_id, sentiment = excluded.sentiment, intent = excluded.intent,
           topic = excluded.topic, resolved = excluded.resolved, handled_by = excluded.handled_by,
           exchanges_count = excluded.exchanges_count, entities = excluded.entities,
           action_suggestion = excluded.action_suggestion, confidence = excluded.confidence,
           justification = excluded.justification, llm_provider = excluded.llm_provider, llm_model = excluded.llm_model,
           abusive = excluded.abusive, summary = excluded.summary,
           satisfaction = excluded.satisfaction, urgence = excluded.urgence, created_at = now()`,
        // `summary` vide vaut absence : un résumé vide affiché comme tel serait pire qu'un repli assumé.
        // `satisfaction` et `urgence` : `?? null`, jamais `?? 0`, qui se lirait « client furieux, aucune urgence ».
        [conversationId, tenantId, a.sentiment, a.intent, a.topic, a.resolved, a.handled_by, a.exchanges_count,
          JSON.stringify(a.entities), a.action_suggestion, a.confidence, a.justification, model.provider, model.model,
          a.abusive === true, a.summary !== undefined && a.summary.trim() !== '' ? a.summary : null,
          a.satisfaction ?? null, a.urgence ?? null],
      );
      await client.query(
        `update conversations set
           analyzed_at = coalesce($2::timestamptz, analyzed_at),
           analysis_status = case
             when exists (
               select 1 from conversation_messages m
               where m.conversation_id = $1 and m.created_at > coalesce($2::timestamptz, analyzed_at, '-infinity'::timestamptz)
             ) then 'pending' else 'done' end
         where id = $1`,
        [conversationId, windowEnd],
      );
      return windowEnd === null ? null : copierSurLaFiche(client, conversationId, tenantId, a, windowEnd);
    });
  }

  /**
   * Marque `done` sans analyse (rien de nouveau), pour ne pas réclamer en boucle. N'avance pas `analyzed_at` : un
   * message arrivé pendant la réclamation repasse la conversation en `pending`.
   */
  async markDone(conversationId: string): Promise<void> {
    await this.pool.query(
      `update conversations set analysis_status = case
         when exists (
           select 1 from conversation_messages m
           where m.conversation_id = $1 and m.created_at > coalesce(conversations.analyzed_at, '-infinity'::timestamptz)
         ) then 'pending' else 'done' end
       where id = $1`,
      [conversationId],
    );
  }

  /** Marque l'échec d'analyse (sortie LLM structurellement invalide : on ne rejoue pas en boucle). */
  async markFailed(conversationId: string): Promise<void> {
    await this.pool.query(`update conversations set analysis_status = 'failed' where id = $1`, [conversationId]);
  }

  /**
   * Relit l'analyse courante d'une conversation pour le job push-analysis, qui ne transporte qu'une référence : un
   * instantané figé pourrait s'ingérer comme nouveau chez mm-hubspot avec un contenu périmé. null si disparue.
   * `satisfaction` et `urgence` ne sont pas relues : ce retour part vers HubSpot (`buildEvent`), et les ajouter
   * changerait un contrat entre dépôts.
   */
  async getStored(conversationId: string): Promise<StoredConversationAnalysis | null> {
    const res = await this.pool.query<{
      conversation_id: string; tenant_id: string; sentiment: string; intent: string; topic: string;
      resolved: boolean; handled_by: string; exchanges_count: number; entities: Record<string, unknown>;
      action_suggestion: string; confidence: number; justification: string; abusive: boolean | null;
    }>(
      `select conversation_id, tenant_id, sentiment, intent, topic, resolved, handled_by, exchanges_count,
              entities, action_suggestion, confidence, justification, abusive
       from conversation_analysis where conversation_id = $1`,
      [conversationId],
    );
    const r = res.rows[0];
    if (!r) return null;
    // Les CHECK SQL garantissent des valeurs d'enum valides, d'où le cast (`tests/intentions-parite.test.ts`).
    return {
      conversationId: r.conversation_id,
      tenantId: r.tenant_id,
      sentiment: r.sentiment as ConversationAnalysis['sentiment'],
      intent: r.intent as ConversationAnalysis['intent'],
      topic: r.topic,
      // Absent vaut « pas d'injure signalée » : un doute ne doit pas faire remonter une conversation.
      abusive: r.abusive ?? false,
      resolved: r.resolved,
      handled_by: r.handled_by as ConversationAnalysis['handled_by'],
      exchanges_count: r.exchanges_count,
      entities: r.entities ?? {},
      action_suggestion: r.action_suggestion as ConversationAnalysis['action_suggestion'],
      confidence: r.confidence,
      justification: r.justification,
    };
  }

  /**
   * Conversations à rattraper pour un espace : celles marquées `pending_catchup` pendant une pause. Registre
   * durable, indépendant de `paused_at` qui s'efface à la reprise. Borné, ordre stable.
   */
  async listConversationIdsPendingCatchup(tenantId: string, limit = 2000): Promise<string[]> {
    const n = Math.max(1, Math.min(5000, Math.floor(limit)));
    const res = await this.pool.query<{ conversation_id: string }>(
      `select conversation_id from conversation_analysis
       where tenant_id = $1 and pending_catchup = true order by created_at asc limit $2`,
      [tenantId, n],
    );
    return res.rows.map((r) => r.conversation_id);
  }

  /**
   * Marque une analyse à rattraper, sans condition : l'appelant décide sur le même instantané que le gate, une
   * relecture ici rouvrirait la course. Idempotent.
   */
  async markPendingCatchup(conversationId: string): Promise<void> {
    await this.pool.query(
      `update conversation_analysis set pending_catchup = true where conversation_id = $1`,
      [conversationId],
    );
  }

  /**
   * Espaces prêts à rattraper (filet du balayage) : des marques `pending_catchup` et au moins un numéro reconnecté.
   * Ne dépend d'aucun événement de reprise : rattrape les marques d'un enfilement de reprise raté. Borné.
   */
  async listTenantsReadyForCatchup(limit = 200): Promise<string[]> {
    const n = Math.max(1, Math.min(1000, Math.floor(limit)));
    const res = await this.pool.query<{ tenant_id: string }>(
      `select distinct ca.tenant_id from conversation_analysis ca
       join phone_numbers pn on pn.tenant_id = ca.tenant_id and pn.hubspot_connected = true
       where ca.pending_catchup = true limit $1`,
      [n],
    );
    return res.rows.map((r) => r.tenant_id);
  }

  /** Efface la marque de rattrapage, après un post réussi. */
  async clearPendingCatchup(conversationId: string): Promise<void> {
    await this.pool.query(
      `update conversation_analysis set pending_catchup = false where conversation_id = $1 and pending_catchup = true`,
      [conversationId],
    );
  }
}

/**
 * Recopie une analyse sur la fiche du contact de sa conversation (Tout sur la fiche, lot 1, migration 0196), dans
 * la transaction de `save`. Rend ce qui a été recopié, ou `null`.
 *
 * LE CONTACT : celui que la conversation désigne (`contact_id`) s'il est actif, sinon la règle de routage des
 * messages entrants (`MATCH_BY_WAID_SQL`). `contact_id` est posé sans regarder `deleted_at` et reste nul pour un
 * fil ouvert avant sa fiche : sans le repli, ces contacts ne recevraient jamais leur analyse. Une fiche supprimée ou
 * purgée ne reçoit rien.
 *
 * 🔴 LA RÈGLE « DERNIÈRE », UNE SEULE POUR TOUT LE PRODUIT : la copie ne se fait que si la fenêtre de cette analyse
 * n'est pas plus ancienne que celle déjà sur la fiche. Une vieille conversation analysée après coup (un fil ouvert
 * sur le BSUID) n'écrase pas une analyse plus récente. `<=` et non `<` : un rejeu du même job réécrit la même copie
 * au lieu d'être refusé, et son `avant` vaut alors son `apres`, ce qui ne fait naître aucun changement.
 *
 * L'ancienne copie est lue sous verrou dans la même instruction (`for update`), sur le modèle du risque
 * (`PgRisqueStore.ecrire`) : deux analyses de deux fils du même contact se sérialisent sur la fiche. `updated_at`
 * ne bouge pas : une analyse n'est pas une modification de la fiche.
 */
async function copierSurLaFiche(
  client: PoolClient, conversationId: string, tenantId: string, a: ConversationAnalysis, windowEnd: string,
): Promise<CopieFiche | null> {
  const conv = await client.query<{ wa_id: string; contact_id: string | null }>(
    `select wa_id, contact_id from conversations where id = $1 and tenant_id = $2`,
    [conversationId, tenantId],
  );
  const fil = conv.rows[0];
  if (!fil) return null;
  let contactId: string | null = null;
  if (fil.contact_id !== null) {
    const designe = await client.query<{ id: string }>(
      `select id from contacts where tenant_id = $1 and id = $2 and deleted_at is null and anonymized_at is null`,
      [tenantId, fil.contact_id],
    );
    contactId = designe.rows[0]?.id ?? null;
  }
  if (contactId === null) {
    const trouve = await client.query<{ id: string }>(
      `select id from contacts where tenant_id = $1 and deleted_at is null and anonymized_at is null
        ${MATCH_BY_WAID_SQL}`,
      [tenantId, fil.wa_id],
    );
    contactId = trouve.rows[0]?.id ?? null;
  }
  if (contactId === null) return null;

  const avantCols = COLONNES_ANALYSE_FICHE.map((k) => `a.${k}`).join(', ');
  const res = await client.query<LigneAnalyseFiche & {
    id: string; phone_e164: string | null; bsuid: string | null; apres_le: Date; apres_fenetre_fin: Date;
  }>(
    `with avant as (
       select c.id, ${COLONNES_ANALYSE_FICHE.map((k) => `c.${k}`).join(', ')}
         from contacts c
        where c.tenant_id = $1 and c.id = $2 and c.deleted_at is null and c.anonymized_at is null
        for update of c
     )
     update contacts c
        set analyse_intention = $4, analyse_sentiment = $5, analyse_satisfaction = $6, analyse_urgence = $7,
            analyse_resolue = $8, analyse_sujet = $9, analyse_traitee_par = $10, analyse_action = $11,
            analyse_le = now(), analyse_fenetre_fin = $12::timestamptz, analyse_conversation_id = $3
       from avant a
      where c.tenant_id = $1 and c.id = a.id
        and (c.analyse_fenetre_fin is null or c.analyse_fenetre_fin <= $12::timestamptz)
     returning c.id, c.phone_e164, c.bsuid, c.analyse_le as apres_le, c.analyse_fenetre_fin as apres_fenetre_fin,
               ${avantCols}`,
    [tenantId, contactId, conversationId, a.intent, a.sentiment, a.satisfaction ?? null, a.urgence ?? null,
      a.resolved, a.topic, a.handled_by, a.action_suggestion, windowEnd],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    contactId: r.id,
    waId: waIdOf(r.phone_e164, r.bsuid),
    avant: analyseDeLaLigne(r),
    apres: {
      intention: a.intent, sentiment: a.sentiment, satisfaction: a.satisfaction ?? null, urgence: a.urgence ?? null,
      resolue: a.resolved, sujet: a.topic, traiteePar: a.handled_by, action: a.action_suggestion,
      analyseLe: r.apres_le, fenetreFin: r.apres_fenetre_fin, conversationId,
    },
  };
}
