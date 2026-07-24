import type { Pool } from 'pg';
import { ALL_QUEUES } from '../queue/names';

/** Rollup par tenant pour la surface d'exploitation cross-tenant (lecture seule). */
export interface TenantOverviewRow {
  id: string;
  name: string;
  createdAt: string;
  mbaEnabled: boolean;
  users: number;
  contacts: number;
  messages: number;
  templatesUsed: number;
  lastSendAt: string | null;
  phone: string | null;
  phoneStatus: string | null;
  quality: string | null;
}

/** Charge d'une file pg-boss : en attente (created+retry), actifs, échoués. Signal VPS -> Railway. */
export interface QueueLoadRow {
  queue: string;
  backlog: number;
  active: number;
  failed: number;
}

export interface GlobalDailyPoint {
  date: string;
  count: number;
}

/** Un numéro à rafraîchir par le sweeper de statut (item 4.10). `waba_id` de la LIGNE (bon WABA en multi-WABA,
 *  contrairement au WABA du tenant). status/quality PERSISTÉS = état d'avant ce passage. */
export interface PhoneForSweepRow {
  id: string;
  tenantId: string;
  wabaId: string | null;
  status: string | null;
  qualityRating: string | null;
}

/** Le nom de schéma pgboss est INTERPOLÉ en SQL (un identifiant n'est pas paramétrable) : on le
 *  valide strictement. Sûr car issu de l'env (config.PGBOSS_SCHEMA), jamais d'une entrée utilisateur. */
function safeSchema(schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error(`schéma pgboss invalide: ${schema}`);
  return schema;
}

/** Agrégats GLOBAUX cross-tenant (lecture seule stricte : aucune écriture, aucune méthode de mutation). */
export class PgOpsStore {
  private readonly schema: string;
  constructor(private readonly pool: Pool, schema = 'pgboss') {
    this.schema = safeSchema(schema);
  }

  /** Un rollup par tenant. Sous-requêtes corrélées (échelle ops = quelques dizaines de tenants). */
  async getTenantOverview(): Promise<TenantOverviewRow[]> {
    const res = await this.pool.query<{
      id: string; name: string; created_at: Date; mba_enabled: boolean;
      users: number; contacts: number; messages: number; templates_used: number;
      last_send_at: Date | null; phone: string | null; phone_status: string | null; quality: string | null;
    }>(
      `select
         t.id, t.name, t.created_at,
         coalesce(ts.mba_enabled, false) as mba_enabled,
         (select count(*) from users u where u.tenant_id = t.id)::int as users,
         (select count(*) from contacts c where c.tenant_id = t.id)::int as contacts,
         (select count(*) from conversation_messages m
            join conversations cv on cv.id = m.conversation_id
          where cv.tenant_id = t.id)::int as messages,
         (select count(distinct ca.template_name) from campaigns ca where ca.tenant_id = t.id)::int as templates_used,
         (select max(r.sent_at) from campaign_recipients r
            join campaigns ca on ca.id = r.campaign_id
          where ca.tenant_id = t.id) as last_send_at,
         pn.display_phone_number as phone, pn.status as phone_status, pn.quality_rating as quality
       from tenants t
       left join tenant_settings ts on ts.tenant_id = t.id
       left join lateral (
         select display_phone_number, status, quality_rating
         from phone_numbers p where p.tenant_id = t.id order by created_at limit 1
       ) pn on true
       order by t.created_at`,
    );
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at.toISOString(),
      mbaEnabled: r.mba_enabled,
      users: Number(r.users),
      contacts: Number(r.contacts),
      messages: Number(r.messages),
      templatesUsed: Number(r.templates_used),
      lastSendAt: r.last_send_at ? r.last_send_at.toISOString() : null,
      phone: r.phone,
      phoneStatus: r.phone_status,
      quality: r.quality,
    }));
  }

  /** Messages échangés / jour (tous tenants) sur les N derniers jours — signal de croissance. */
  async getGlobalDaily(days: number): Promise<GlobalDailyPoint[]> {
    const n = Math.max(1, Math.min(90, Math.floor(days)));
    const res = await this.pool.query<{ date: string; count: string }>(
      `select to_char(m.created_at at time zone 'Europe/Paris', 'YYYY-MM-DD') as date, count(*)::int as count
       from conversation_messages m
       where m.created_at >= (now() - ($1::int * interval '1 day'))
       group by 1 order by 1`,
      [n],
    );
    return res.rows.map((r) => ({ date: r.date, count: Number(r.count) }));
  }

  /**
   * Charge des files pg-boss (SQL brut sur `<schema>.job`, autoritatif). L'API et le worker sont des
   * process séparés : on lit l'état en base, pas via l'instance pg-boss du worker. Tolère l'absence de
   * la table (pg-boss pas encore initialisé) -> renvoie des zéros plutôt que de planter la route.
   */
  async getQueueLoad(): Promise<QueueLoadRow[]> {
    const zero = (): QueueLoadRow[] => ALL_QUEUES.map((q) => ({ queue: q, backlog: 0, active: 0, failed: 0 }));
    try {
      const res = await this.pool.query<{ name: string; state: string; count: string }>(
        `select name, state, count(*)::int as count
         from ${this.schema}.job
         where name = any($1) and state in ('created', 'retry', 'active', 'failed')
         group by name, state`,
        [ALL_QUEUES],
      );
      const byQueue = new Map<string, QueueLoadRow>(ALL_QUEUES.map((q) => [q, { queue: q, backlog: 0, active: 0, failed: 0 }]));
      for (const row of res.rows) {
        const q = byQueue.get(row.name);
        if (!q) continue;
        const c = Number(row.count);
        if (row.state === 'created' || row.state === 'retry') q.backlog += c;
        else if (row.state === 'active') q.active += c;
        else if (row.state === 'failed') q.failed += c;
      }
      return ALL_QUEUES.map((q) => byQueue.get(q)!);
    } catch (err) {
      // 42P01 = undefined_table (schéma/table pgboss absent) -> pas d'erreur, juste des zéros.
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '42P01') return zero();
      throw err;
    }
  }

  /**
   * Numéros à rafraîchir par le sweeper de statut (item 4.10), CROSS-TENANT (lecture seule stricte, comme le
   * reste de ce store). C'est la seule lecture cross-tenant de phone_numbers du store d'ops. BORNÉE : le pull
   * fait 2 GET Graph par numéro, LIMIT protège le budget si le parc grandit. Ordre stable (created_at).
   */
  async listNumbersForStatusSweep(limit = 200): Promise<PhoneForSweepRow[]> {
    const n = Math.max(1, Math.min(1000, Math.floor(limit)));
    const res = await this.pool.query<{ id: string; tenant_id: string; waba_id: string | null; status: string | null; quality_rating: string | null }>(
      `select id, tenant_id, waba_id, status, quality_rating from phone_numbers order by created_at limit $1`,
      [n],
    );
    return res.rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, wabaId: r.waba_id, status: r.status, qualityRating: r.quality_rating }));
  }
}
