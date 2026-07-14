import type { Pool } from 'pg';
import type { AnalysisContext } from './analyzer';
import type { AnalysisMessage } from './engine';
import type { ConversationAnalysis } from './schema';

/** Une conversation réclamée pour analyse. */
export interface ClaimedConversation {
  conversationId: string;
  tenantId: string;
}

/**
 * Store Postgres de la passe d'analyse. Réclamation atomique (pending -> queued, FOR UPDATE SKIP LOCKED, même patron
 * que le claim de campagne) pour ne traiter chaque conversation qu'une fois malgré concurrence/replay. La fenêtre
 * analysée est bornée aux messages postérieurs à `analyzed_at` (la conversation ne se ferme jamais -> on analyse
 * l'épisode depuis la dernière analyse : coût + pertinence).
 */
export class PgConversationAnalysisStore {
  constructor(private readonly pool: Pool) {}

  /** Réclame en lot les conversations inactives (last_message_at ancien) encore `pending` -> `queued`. */
  async claimForAnalysis(inactivityMs: number, limit: number): Promise<ClaimedConversation[]> {
    const res = await this.pool.query<{ id: string; tenant_id: string }>(
      `update conversations set analysis_status = 'queued', analysis_queued_at = now()
       where id in (
         select id from conversations
         where analysis_status = 'pending' and last_message_at < now() - make_interval(secs => $1 / 1000.0)
         order by last_message_at asc
         limit $2
         for update skip locked
       )
       returning id, tenant_id`,
      [inactivityMs, limit],
    );
    return res.rows.map((r) => ({ conversationId: r.id, tenantId: r.tenant_id }));
  }

  /** Ramène en `pending` les conversations bloquées en `queued` (worker mort en cours de traitement). Nb récupéré. */
  async reclaimStaleQueued(olderThanMs: number): Promise<number> {
    const res = await this.pool.query(
      `update conversations set analysis_status = 'pending'
       where analysis_status = 'queued' and analysis_queued_at < now() - make_interval(secs => $1 / 1000.0)`,
      [olderThanMs],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Contexte d'analyse d'une conversation : messages depuis la dernière analyse (bornés) + signaux déterministes.
   * Depuis la Pièce 0, les envois automatisés (campagne/workflow) sont dans conversation_messages -> les signaux se
   * lisent directement des messages (humain = sortant avec sender_user_id ; automatisé = sortant sans). null si la
   * conversation n'existe plus.
   */
  async getContext(conversationId: string): Promise<AnalysisContext | null> {
    const conv = await this.pool.query<{ analyzed_at: Date | null }>(
      `select analyzed_at from conversations where id = $1`,
      [conversationId],
    );
    if ((conv.rowCount ?? 0) === 0) return null;
    const rows = await this.pool.query<{ direction: 'in' | 'out'; body: string | null; type: string | null; sender_user_id: string | null; created_at: Date }>(
      `select direction, body, type, sender_user_id, created_at from conversation_messages
       where conversation_id = $1 and created_at > coalesce((select analyzed_at from conversations where id = $1), '-infinity'::timestamptz)
       order by created_at asc, id asc
       limit 500`,
      [conversationId],
    );
    const messages: AnalysisMessage[] = rows.rows.map((r) => ({ direction: r.direction, body: r.body, type: r.type, senderUserId: r.sender_user_id }));
    const hasHumanOutbound = messages.some((m) => m.direction === 'out' && m.senderUserId != null);
    const hasAutomated = messages.some((m) => m.direction === 'out' && m.senderUserId == null);
    // Ordre ASC + limit 500 : le dernier lu est le max created_at de la fenêtre (si >500 messages, le reste sera repris).
    const windowEnd = rows.rows.length > 0 ? rows.rows[rows.rows.length - 1]!.created_at : null;
    return { messages, signals: { hasHumanOutbound, hasAutomated }, windowEnd };
  }

  /**
   * Persiste l'analyse (upsert 1 ligne/conversation) + avance `analyzed_at` jusqu'à `windowEnd` (borne des messages
   * réellement analysés, PAS now()) + repasse la conversation en `pending` s'il reste des messages plus récents que la
   * borne (arrivés pendant l'analyse) sinon `done`. Le tout en 1 transaction. `windowEnd` null -> pas d'avancée de borne.
   */
  async save(conversationId: string, tenantId: string, a: ConversationAnalysis, model: { provider: string; model: string }, windowEnd: Date | null): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into conversation_analysis
           (conversation_id, tenant_id, sentiment, intent, topic, resolved, handled_by, exchanges_count, entities,
            action_suggestion, confidence, justification, llm_provider, llm_model)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)
         on conflict (conversation_id) do update set
           tenant_id = excluded.tenant_id, sentiment = excluded.sentiment, intent = excluded.intent,
           topic = excluded.topic, resolved = excluded.resolved, handled_by = excluded.handled_by,
           exchanges_count = excluded.exchanges_count, entities = excluded.entities,
           action_suggestion = excluded.action_suggestion, confidence = excluded.confidence,
           justification = excluded.justification, llm_provider = excluded.llm_provider, llm_model = excluded.llm_model,
           created_at = now()`,
        [conversationId, tenantId, a.sentiment, a.intent, a.topic, a.resolved, a.handled_by, a.exchanges_count,
          JSON.stringify(a.entities), a.action_suggestion, a.confidence, a.justification, model.provider, model.model],
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
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Marque `done` sans analyse (rien de nouveau depuis la dernière passe) -> ne re-claim pas en boucle. N'avance PAS
   * `analyzed_at` (aucun message analysé) : si un message est arrivé pendant le claim (created_at > analyzed_at), on
   * repasse en `pending` pour le reprendre au lieu de l'enterrer sous une borne now().
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

  /** Marque la conversation en échec d'analyse (sortie LLM structurellement invalide : on ne rejoue pas en boucle). */
  async markFailed(conversationId: string): Promise<void> {
    await this.pool.query(`update conversations set analysis_status = 'failed' where id = $1`, [conversationId]);
  }
}
