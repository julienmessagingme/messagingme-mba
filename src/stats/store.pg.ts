import type { Pool } from 'pg';

export interface DailyPoint {
  date: string; // 'YYYY-MM-DD' (Europe/Paris)
  count: number;
}

export interface DashboardStats {
  contacts: DailyPoint[];
  templates: { utility: DailyPoint[]; marketing: DailyPoint[] };
  exchanged: DailyPoint[];
}

const TZ = 'Europe/Paris';

/** Séries « 1 point par jour » pour le dashboard. Buckets jour en tz Europe/Paris. */
export class PgStatsStore {
  constructor(private readonly pool: Pool) {}

  async getDashboard(tenantId: string, days: number): Promise<DashboardStats> {
    const window = Math.min(Math.max(days, 1), 365);
    const since = new Date(Date.now() - window * 24 * 3600 * 1000);

    // 1) Contacts créés / jour.
    const contacts = await this.pool.query<{ d: string; count: string }>(
      `select to_char(date_trunc('day', created_at at time zone $3), 'YYYY-MM-DD') as d, count(*)::int as count
       from contacts where tenant_id = $1 and created_at >= $2
       group by d order by d`,
      [tenantId, since, TZ],
    );

    // 2) Templates envoyés / jour, par catégorie : campagnes (campaign_recipients + campaigns.category)
    //    + envois template depuis l'inbox (conversation_messages.template_category).
    const templates = await this.pool.query<{ d: string; category: string | null; count: string }>(
      `select d, category, sum(cnt)::int as count from (
         select to_char(date_trunc('day', r.sent_at at time zone $3), 'YYYY-MM-DD') d, c.category, count(*) cnt
         from campaign_recipients r join campaigns c on c.id = r.campaign_id
         where c.tenant_id = $1 and r.status = 'sent' and r.sent_at >= $2
           and (r.delivery_status is null or r.delivery_status <> 'failed')
         group by d, c.category
         union all
         select to_char(date_trunc('day', m.created_at at time zone $3), 'YYYY-MM-DD') d, m.template_category, count(*) cnt
         from conversation_messages m join conversations cv on cv.id = m.conversation_id
         where cv.tenant_id = $1 and m.direction = 'out' and m.type = 'template'
           and m.template_category is not null and m.created_at >= $2
         group by d, m.template_category
       ) x group by d, category order by d`,
      [tenantId, since, TZ],
    );

    // 3) Messages échangés hors template / jour : reçus + réponses texte sortantes.
    const exchanged = await this.pool.query<{ d: string; count: string }>(
      `select to_char(date_trunc('day', m.created_at at time zone $3), 'YYYY-MM-DD') as d, count(*)::int as count
       from conversation_messages m join conversations cv on cv.id = m.conversation_id
       where cv.tenant_id = $1 and m.created_at >= $2
         and (m.direction = 'in' or (m.direction = 'out' and m.type is distinct from 'template'))
       group by d order by d`,
      [tenantId, since, TZ],
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
}
