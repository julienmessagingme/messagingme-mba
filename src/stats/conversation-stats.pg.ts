import type { Pool } from 'pg';
import { STATS_TZ } from './range';
import type { DateRange } from './range';

/**
 * LECTURE des agrégats d'analyse de conversation (Pièce 1, table `conversation_analysis`). Séparé du store
 * d'ÉCRITURE `src/analysis/store.pg.ts` (comme stats vs inbox). AUCUN appel LLM : pur SQL sur des colonnes
 * déjà remplies. `tenant_id = $1` sur CHAQUE requête (double barrière avec scopeTenant côté route : IDOR).
 *
 * ⚠️ Sémantique temporelle : `conversation_analysis.created_at` est réécrit à now() à chaque ré-analyse
 * (upsert), donc c'est la date de DERNIÈRE analyse, pas de la conversation. L'agrégat est un INSTANTANÉ
 * « à date de dernière analyse » fenêtré, pas un registre historique. Index `(tenant_id, created_at)` exploité.
 */

const TZ = STATS_TZ;

export interface ConversationAnalysisSummary {
  /** Feature d'analyse active côté serveur (config). Distingue « inactif » de « aucune donnée ». */
  enabled: boolean;
  total: number;
  sentiment: { positif: number; neutre: number; negatif: number };
  intent: { demande_devis: number; sav: number; reclamation: number; information: number; prise_rdv: number; autre: number };
  resolution: { resolved: number; unresolved: number; rate: number | null }; // rate 0..1, null si total=0
  handledBy: { humain: number; automatise: number; mba: number };
  exchanges: { avg: number | null; median: number | null };
  actions: { creer_devis: number; rappeler: number; relancer: number; escalader: number; aucune: number };
  topTopics: Array<{ topic: string; count: number }>;
  confidence: { lt50: number; from50to70: number; from70to90: number; gte90: number };
}

export interface AnalyzedConversationsFilter {
  sentiment?: string;
  intent?: string;
  action?: string;
  limit?: number;
}

export interface AnalyzedConversationRow {
  conversationId: string;
  waId: string;
  profileName: string | null;
  sentiment: string;
  intent: string;
  topic: string;
  resolved: boolean;
  actionSuggestion: string;
  confidence: number;
  justification: string;
  handledBy: string;
  exchangesCount: number;
  analyzedAt: string; // ISO (conversation_analysis.created_at)
  inboxHref: string; // /inbox?c=<conversationId>
}

/** `enabled` injecté (= config.CONVERSATION_ANALYSIS_ENABLED === 'true') : la lecture d'agrégats ne coûte rien,
 *  mais on remonte l'état de la feature pour un empty-state différencié. */
export class PgConversationStatsStore {
  constructor(private readonly pool: Pool, private readonly enabled: boolean) {}

  async getSummary(tenantId: string, range: DateRange): Promise<ConversationAnalysisSummary> {
    const { from, to } = range;
    // UNE passe : tous les compteurs par count(*) FILTER + avg + médiane (un seul scan de l'index).
    const agg = await this.pool.query<{
      total: string;
      s_pos: string; s_neu: string; s_neg: string;
      i_devis: string; i_sav: string; i_recl: string; i_info: string; i_rdv: string; i_autre: string;
      resolved: string; unresolved: string;
      h_humain: string; h_auto: string; h_mba: string;
      avg_ex: string | null; median_ex: string | null;
      a_devis: string; a_rappeler: string; a_relancer: string; a_escalader: string; a_aucune: string;
      c_lt50: string; c_50_70: string; c_70_90: string; c_gte90: string;
    }>(
      `with bounds as (
         select ($2::date)::timestamp at time zone $4 as start_ts,
                (($3::date) + 1)::timestamp at time zone $4 as end_ts
       )
       select
         count(*)::int as total,
         count(*) filter (where sentiment = 'positif')::int as s_pos,
         count(*) filter (where sentiment = 'neutre')::int as s_neu,
         count(*) filter (where sentiment = 'negatif')::int as s_neg,
         count(*) filter (where intent = 'demande_devis')::int as i_devis,
         count(*) filter (where intent = 'sav')::int as i_sav,
         count(*) filter (where intent = 'reclamation')::int as i_recl,
         count(*) filter (where intent = 'information')::int as i_info,
         count(*) filter (where intent = 'prise_rdv')::int as i_rdv,
         count(*) filter (where intent = 'autre')::int as i_autre,
         count(*) filter (where resolved)::int as resolved,
         count(*) filter (where not resolved)::int as unresolved,
         count(*) filter (where handled_by = 'humain')::int as h_humain,
         count(*) filter (where handled_by = 'automatise')::int as h_auto,
         count(*) filter (where handled_by = 'mba')::int as h_mba,
         avg(exchanges_count)::float as avg_ex,
         percentile_cont(0.5) within group (order by exchanges_count) as median_ex,
         count(*) filter (where action_suggestion = 'creer_devis')::int as a_devis,
         count(*) filter (where action_suggestion = 'rappeler')::int as a_rappeler,
         count(*) filter (where action_suggestion = 'relancer')::int as a_relancer,
         count(*) filter (where action_suggestion = 'escalader')::int as a_escalader,
         count(*) filter (where action_suggestion = 'aucune')::int as a_aucune,
         count(*) filter (where confidence < 0.5)::int as c_lt50,
         count(*) filter (where confidence >= 0.5 and confidence < 0.7)::int as c_50_70,
         count(*) filter (where confidence >= 0.7 and confidence < 0.9)::int as c_70_90,
         count(*) filter (where confidence >= 0.9)::int as c_gte90
       from conversation_analysis ca, bounds b
       where ca.tenant_id = $1 and ca.created_at >= b.start_ts and ca.created_at < b.end_ts`,
      [tenantId, from, to, TZ],
    );

    // Top topics : GROUP BY séparé (cardinalité variable). lower(btrim) pour regrouper casse/espaces.
    const topics = await this.pool.query<{ topic: string; n: string }>(
      `with bounds as (
         select ($2::date)::timestamp at time zone $4 as start_ts, (($3::date) + 1)::timestamp at time zone $4 as end_ts
       )
       select lower(btrim(topic)) as topic, count(*)::int as n
       from conversation_analysis ca, bounds b
       where ca.tenant_id = $1 and ca.created_at >= b.start_ts and ca.created_at < b.end_ts
         and btrim(topic) <> ''
       group by 1 order by n desc, topic asc limit 10`,
      [tenantId, from, to, TZ],
    );

    const r = agg.rows[0]!;
    const total = Number(r.total);
    const resolved = Number(r.resolved);
    return {
      enabled: this.enabled,
      total,
      sentiment: { positif: Number(r.s_pos), neutre: Number(r.s_neu), negatif: Number(r.s_neg) },
      intent: {
        demande_devis: Number(r.i_devis), sav: Number(r.i_sav), reclamation: Number(r.i_recl),
        information: Number(r.i_info), prise_rdv: Number(r.i_rdv), autre: Number(r.i_autre),
      },
      resolution: { resolved, unresolved: Number(r.unresolved), rate: total > 0 ? resolved / total : null },
      handledBy: { humain: Number(r.h_humain), automatise: Number(r.h_auto), mba: Number(r.h_mba) },
      exchanges: { avg: r.avg_ex !== null ? Number(r.avg_ex) : null, median: r.median_ex !== null ? Number(r.median_ex) : null },
      actions: {
        creer_devis: Number(r.a_devis), rappeler: Number(r.a_rappeler), relancer: Number(r.a_relancer),
        escalader: Number(r.a_escalader), aucune: Number(r.a_aucune),
      },
      topTopics: topics.rows.map((t) => ({ topic: t.topic, count: Number(t.n) })),
      confidence: { lt50: Number(r.c_lt50), from50to70: Number(r.c_50_70), from70to90: Number(r.c_70_90), gte90: Number(r.c_gte90) },
    };
  }

  /** N dernières conversations analysées de la plage, filtrables. Join conversations (wa_id) + contacts
   *  (profile_name), lien inbox `/inbox?c=<id>`. Filtres validés côté route (enum), passés en $ nullable. */
  async listAnalyzed(tenantId: string, range: DateRange, filters: AnalyzedConversationsFilter): Promise<AnalyzedConversationRow[]> {
    const { from, to } = range;
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const res = await this.pool.query<{
      conversation_id: string; wa_id: string; profile_name: string | null;
      sentiment: string; intent: string; topic: string; resolved: boolean; action_suggestion: string;
      confidence: number; justification: string; handled_by: string; exchanges_count: number; created_at: Date;
    }>(
      `with bounds as (
         select ($2::date)::timestamp at time zone $4 as start_ts, (($3::date) + 1)::timestamp at time zone $4 as end_ts
       )
       select ca.conversation_id, c.wa_id, ct.profile_name,
              ca.sentiment, ca.intent, ca.topic, ca.resolved, ca.action_suggestion,
              ca.confidence, ca.justification, ca.handled_by, ca.exchanges_count, ca.created_at
       from conversation_analysis ca
         join conversations c on c.id = ca.conversation_id
         left join contacts ct on ct.id = c.contact_id, bounds b
       where ca.tenant_id = $1 and ca.created_at >= b.start_ts and ca.created_at < b.end_ts
         and ($5::text is null or ca.sentiment = $5::text)
         and ($6::text is null or ca.intent = $6::text)
         and ($7::text is null or ca.action_suggestion = $7::text)
       order by ca.created_at desc
       limit $8`,
      [tenantId, from, to, TZ, filters.sentiment ?? null, filters.intent ?? null, filters.action ?? null, limit],
    );
    return res.rows.map((r) => ({
      conversationId: r.conversation_id,
      waId: r.wa_id,
      profileName: r.profile_name,
      sentiment: r.sentiment,
      intent: r.intent,
      topic: r.topic,
      resolved: r.resolved,
      actionSuggestion: r.action_suggestion,
      confidence: r.confidence,
      justification: r.justification,
      handledBy: r.handled_by,
      exchangesCount: r.exchanges_count,
      analyzedAt: r.created_at.toISOString(),
      inboxHref: `/inbox?c=${r.conversation_id}`,
    }));
  }
}
