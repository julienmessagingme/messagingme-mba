import type { Pool } from 'pg';
import { STATS_TZ } from './range';
import type { DateRange } from './range';

export interface DailyPoint {
  date: string; // 'YYYY-MM-DD' (Europe/Paris)
  count: number;
}

/** Funnel d'UNE campagne : envoyés -> délivrés -> lus -> répondus (message entrant après l'envoi), + échecs. */
export interface CampaignFunnel {
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
}

/** Une ligne du breakdown d'erreurs : code Meta numérique + occurrences sur la plage. */
export interface ErrorBreakdownRow {
  code: number;
  count: number;
}

/** Volume d'envois de campagne par (jour, catégorie) — base du graphe de coût estimé. */
export interface CostVolumeRow {
  date: string; // 'YYYY-MM-DD' (Europe/Paris)
  category: string; // 'marketing' | 'utility'
  count: number;
}

/** Filtre optionnel du graphe de coût : une campagne OU un template précis. */
export interface CostFilter {
  campaignId?: string;
  templateName?: string;
}

export interface DashboardStats {
  /** CUMULATIF : total de contacts à chaque jour (dense, une valeur/jour, reporte les jours sans ajout). */
  contacts: DailyPoint[];
  templates: { utility: DailyPoint[]; marketing: DailyPoint[] };
  exchanged: DailyPoint[];
}

/** Un template envoyé sur la période, avec son volume (pour le dropdown + le prix estimé). */
export interface TemplateBreakdownRow {
  name: string;
  category: string | null; // 'marketing' | 'utility' | null (envoi inbox sans catégorie)
  count: number;
}

const TZ = STATS_TZ;

/** Séries « 1 point par jour » pour le dashboard. Buckets jour en tz Europe/Paris.
 *  Plage `range` (from..to INCLUS, Europe/Paris) : bornes SQL calculées via bounds CTE (DST-safe),
 *  borne haute EXCLUSIVE = minuit Paris de (to+1). Params partout : [tenantId, from, to, TZ]. */
export class PgStatsStore {
  constructor(private readonly pool: Pool) {}

  async getDashboard(tenantId: string, range: DateRange): Promise<DashboardStats> {
    const { from, to } = range;

    // 1) Contacts CUMULÉS / jour : total courant = baseline (contacts créés AVANT la plage) +
    //    somme courante des nouveaux/jour. Série DENSE (generate_series de from à to) pour que les jours
    //    sans nouvel ajout reportent le total (pas de retour à 0), sans logique côté front.
    const contacts = await this.pool.query<{ d: string; count: string }>(
      `with bounds as (
         select ($2::date)::timestamp at time zone $4 as start_ts,
                (($3::date) + 1)::timestamp at time zone $4 as end_ts
       ),
       series as (
         select generate_series($2::date, $3::date, interval '1 day')::date as day
       ),
       baseline as (
         select count(*)::int as n from contacts
         where tenant_id = $1 and created_at < (select start_ts from bounds)
       ),
       daily as (
         select date_trunc('day', created_at at time zone $4)::date as day, count(*)::int as n
         from contacts, bounds b
         where tenant_id = $1 and created_at >= b.start_ts and created_at < b.end_ts
         group by 1
       )
       select to_char(s.day, 'YYYY-MM-DD') as d,
              ((select n from baseline) + coalesce(sum(dl.n) over (order by s.day), 0))::int as count
       from series s left join daily dl on dl.day = s.day
       order by s.day`,
      [tenantId, from, to, TZ],
    );

    // 2) Templates envoyés / jour, par catégorie : campagnes (campaign_recipients + campaigns.category)
    //    + envois template depuis l'inbox (conversation_messages.template_category).
    const templates = await this.pool.query<{ d: string; category: string | null; count: string }>(
      `with bounds as (
         select ($2::date)::timestamp at time zone $4 as start_ts, (($3::date) + 1)::timestamp at time zone $4 as end_ts
       )
       select d, category, sum(cnt)::int as count from (
         select to_char(date_trunc('day', r.sent_at at time zone $4), 'YYYY-MM-DD') d, c.category, count(*) cnt
         from campaign_recipients r join campaigns c on c.id = r.campaign_id, bounds b
         where c.tenant_id = $1 and r.status = 'sent' and r.sent_at >= b.start_ts and r.sent_at < b.end_ts
           and (r.delivery_status is null or r.delivery_status <> 'failed')
         group by d, c.category
         union all
         select to_char(date_trunc('day', m.created_at at time zone $4), 'YYYY-MM-DD') d, m.template_category, count(*) cnt
         from conversation_messages m join conversations cv on cv.id = m.conversation_id, bounds b
         where cv.tenant_id = $1 and m.direction = 'out' and m.type = 'template'
           and m.template_category is not null and m.created_at >= b.start_ts and m.created_at < b.end_ts
         group by d, m.template_category
       ) x group by d, category order by d`,
      [tenantId, from, to, TZ],
    );

    // 3) Messages échangés hors template / jour : reçus + réponses texte sortantes.
    const exchanged = await this.pool.query<{ d: string; count: string }>(
      `with bounds as (
         select ($2::date)::timestamp at time zone $4 as start_ts, (($3::date) + 1)::timestamp at time zone $4 as end_ts
       )
       select to_char(date_trunc('day', m.created_at at time zone $4), 'YYYY-MM-DD') as d, count(*)::int as count
       from conversation_messages m join conversations cv on cv.id = m.conversation_id, bounds b
       where cv.tenant_id = $1 and m.created_at >= b.start_ts and m.created_at < b.end_ts
         and (m.direction = 'in' or (m.direction = 'out' and m.type is distinct from 'template'))
       group by d order by d`,
      [tenantId, from, to, TZ],
    );

    const utility: DailyPoint[] = [];
    const marketing: DailyPoint[] = [];
    for (const r of templates.rows) {
      const point = { date: r.d, count: Number(r.count) };
      if (r.category === 'marketing') marketing.push(point);
      else if (r.category === 'utility') utility.push(point);
    }

    return {
      contacts: contacts.rows.map((r) => ({ date: r.d, count: Number(r.count) })),
      templates: { utility, marketing },
      exchanged: exchanged.rows.map((r) => ({ date: r.d, count: Number(r.count) })),
    };
  }

  /**
   * Volume par template envoyé sur la période (campagnes + envois inbox), pour le dropdown du
   * dashboard et le prix estimé. Exclut les livraisons en échec (delivery_status='failed').
   */
  async getTemplateBreakdown(tenantId: string, range: DateRange): Promise<TemplateBreakdownRow[]> {
    const { from, to } = range;
    const res = await this.pool.query<{ name: string; category: string | null; count: string }>(
      `with bounds as (
         select ($2::date)::timestamp at time zone $4 as start_ts, (($3::date) + 1)::timestamp at time zone $4 as end_ts
       )
       select name, category, sum(cnt)::int as count from (
         select c.template_name as name, c.category as category, count(*) cnt
         from campaign_recipients r join campaigns c on c.id = r.campaign_id, bounds b
         where c.tenant_id = $1 and c.template_name is not null and r.status = 'sent'
           and r.sent_at >= b.start_ts and r.sent_at < b.end_ts
           and (r.delivery_status is null or r.delivery_status <> 'failed')
         group by c.template_name, c.category
         union all
         select m.template_name as name, m.template_category as category, count(*) cnt
         from conversation_messages m join conversations cv on cv.id = m.conversation_id, bounds b
         where cv.tenant_id = $1 and m.direction = 'out' and m.type = 'template'
           and m.template_name is not null and m.created_at >= b.start_ts and m.created_at < b.end_ts
         group by m.template_name, m.template_category
       ) x group by name, category order by count desc`,
      [tenantId, from, to, TZ],
    );
    return res.rows.map((r) => ({ name: r.name, category: r.category, count: Number(r.count) }));
  }

  /**
   * Funnel d'UNE campagne (scopée au tenant) : envoyés -> délivrés -> lus -> répondus, + échecs.
   * « répondu » = il existe un message ENTRANT (conversation_messages.direction='in') du même numéro
   * APRÈS son envoi (created_at > sent_at) ET attribué à CETTE campagne : aucun envoi ULTÉRIEUR au même
   * numéro (même tenant) n'a eu lieu entre cet envoi et la réponse (sinon la réponse est attribuée au
   * dernier envoi, pas à celui-ci). Évite le double-comptage d'une même réponse sur plusieurs campagnes.
   * NB : « répondu » peut dépasser « lu » (accusés de lecture désactivés côté client) — signal indépendant.
   */
  async getCampaignFunnel(tenantId: string, campaignId: string): Promise<CampaignFunnel> {
    const res = await this.pool.query<{ sent: string; delivered: string; read: string; replied: string; failed: string }>(
      `select
         count(r.id) filter (where r.status = 'sent' and r.delivery_status is distinct from 'failed')::int as sent,
         count(r.id) filter (where r.delivery_status in ('delivered', 'read'))::int as delivered,
         count(r.id) filter (where r.delivery_status = 'read')::int as read,
         count(r.id) filter (where r.status = 'failed' or r.delivery_status = 'failed')::int as failed,
         count(r.id) filter (where r.sent_at is not null and exists (
           select 1 from conversations cv
             join conversation_messages m on m.conversation_id = cv.id
           where cv.tenant_id = c.tenant_id
             and cv.wa_id = regexp_replace(r.to_e164, '[^0-9]', '', 'g')
             and m.direction = 'in'
             and m.created_at > r.sent_at
             and not exists (
               select 1 from campaign_recipients r2 join campaigns c2 on c2.id = r2.campaign_id
               where c2.tenant_id = c.tenant_id
                 and r2.to_e164 = r.to_e164
                 and r2.sent_at is not null
                 and r2.sent_at > r.sent_at
                 and r2.sent_at < m.created_at
             )
         ))::int as replied
       from campaign_recipients r join campaigns c on c.id = r.campaign_id
       where c.id = $1 and c.tenant_id = $2`,
      [campaignId, tenantId],
    );
    const row = res.rows[0];
    return {
      sent: Number(row?.sent ?? 0),
      delivered: Number(row?.delivered ?? 0),
      read: Number(row?.read ?? 0),
      replied: Number(row?.replied ?? 0),
      failed: Number(row?.failed ?? 0),
    };
  }

  /**
   * Breakdown des codes d'erreur Meta sur la plage (campagnes du tenant). Ancré sur
   * coalesce(delivery_updated_at, sent_at, claimed_at) pour capter à la fois les échecs de LIVRAISON
   * (delivery_updated_at) et d'ENVOI (claimed_at, sent_at null). Trié par occurrences décroissantes.
   */
  async getErrorBreakdown(tenantId: string, range: DateRange): Promise<ErrorBreakdownRow[]> {
    const { from, to } = range;
    const res = await this.pool.query<{ code: number; count: string }>(
      `with bounds as (
         select ($2::date)::timestamp at time zone $4 as start_ts, (($3::date) + 1)::timestamp at time zone $4 as end_ts
       )
       select r.error_code as code, count(*)::int as count
       from campaign_recipients r join campaigns c on c.id = r.campaign_id, bounds b
       where c.tenant_id = $1 and r.error_code is not null
         and coalesce(r.delivery_updated_at, r.sent_at, r.claimed_at) >= b.start_ts
         and coalesce(r.delivery_updated_at, r.sent_at, r.claimed_at) < b.end_ts
       group by r.error_code
       order by count desc, code asc`,
      [tenantId, from, to, TZ],
    );
    return res.rows.map((r) => ({ code: Number(r.code), count: Number(r.count) }));
  }

  /**
   * Volume d'envois de campagne par (jour Paris, catégorie) sur la plage, filtrable par campagne OU
   * template. Base du graphe de coût estimé (multiplié ensuite par le tarif Meta de la catégorie).
   * N'inclut que les envois réussis (status='sent', livraison non 'failed'), ancrés sur sent_at.
   */
  async getCostVolume(tenantId: string, range: DateRange, filter: CostFilter): Promise<CostVolumeRow[]> {
    const { from, to } = range;
    const res = await this.pool.query<{ date: string; category: string; count: string }>(
      `with bounds as (
         select ($2::date)::timestamp at time zone $4 as start_ts, (($3::date) + 1)::timestamp at time zone $4 as end_ts
       )
       select to_char(r.sent_at at time zone $4, 'YYYY-MM-DD') as date, c.category as category, count(*)::int as count
       from campaign_recipients r join campaigns c on c.id = r.campaign_id, bounds b
       where c.tenant_id = $1
         and r.status = 'sent' and r.delivery_status is distinct from 'failed'
         and r.sent_at >= b.start_ts and r.sent_at < b.end_ts
         and ($5::uuid is null or c.id = $5::uuid)
         and ($6::text is null or c.template_name = $6::text)
       group by 1, 2`,
      [tenantId, from, to, TZ, filter.campaignId ?? null, filter.templateName ?? null],
    );
    return res.rows.map((r) => ({ date: r.date, category: r.category, count: Number(r.count) }));
  }
}
