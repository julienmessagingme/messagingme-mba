import type { Pool } from 'pg';
import { ALL_QUEUES, BASE_QUEUES, dlqName } from '../queue/names';

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

/** Charge d'une file pg-boss : en attente (created+retry), actifs, échoués. */
export interface QueueLoadRow {
  queue: string;
  backlog: number;
  active: number;
  failed: number;
  /**
   * Âge, en secondes, du plus vieux job prêt et pas encore fini ; `0` s'il n'y en a aucun. C'est la mesure qui
   * dit si on tient la cadence (la profondeur ne la remplace pas). Mesuré depuis `start_after` : un job
   * programmé pour plus tard n'est pas en retard.
   */
  ageMaxSecondes: number;
}

/**
 * La latence réelle d'une file sur une fenêtre, calculée sur les jobs terminés. Lire `echantillons` d'abord :
 * un p95 sur trois jobs ne veut rien dire, et la rétention de pg-boss décide de ce qui reste lisible.
 *
 * Dans `QueueGroupLoadRow` (le plus vieux job en attente d'un groupe : l'équité qu'une moyenne cache),
 * `groupe` dépend de la file : l'espace pour `campaign-run`, le contact (`<numéro>:<wa_id>`) pour `webhook`.
 */
export interface QueueLatenceRow {
  queue: string;
  echantillons: number;
  /** Temps pendant lequel personne ne s'occupait du job (cadence de sondage, concurrence saturée). */
  attenteP50Secondes: number;
  attenteP95Secondes: number;
  /** Attente plus traitement : ce que l'utilisateur ressent. */
  boutEnBoutP95Secondes: number;
  boutEnBoutMaxSecondes: number;
}

export interface QueueGroupLoadRow {
  queue: string;
  groupe: string;
  backlog: number;
  ageMaxSecondes: number;
}

/**
 * Un job mort : il a épuisé ses rejeux et rien ne consomme les DLQ, il y reste jusqu'à un rejeu manuel. Pour
 * un `webhook`, c'est un message de client jamais traité, en silence.
 */
export interface JobMortRow {
  id: string;
  /** La file d'origine (sans le suffixe), celle où le rejeu le remettra. */
  queue: string;
  data: unknown;
  creeLe: string;
  /** Ce que la dernière tentative a laissé comme trace, tronqué : de quoi décider, pas de quoi enquêter. */
  erreur: string | null;
}

export interface GlobalDailyPoint {
  date: string;
  count: number;
}

/** Un numéro à rafraîchir par le sweeper de statut. `waba_id` de la ligne (le bon WABA en multi-WABA, pas
 *  celui du tenant) ; status/quality persistés = état d'avant ce passage. */
export interface PhoneForSweepRow {
  id: string;
  tenantId: string;
  wabaId: string | null;
  status: string | null;
  qualityRating: string | null;
}

/** Le nom de schéma pgboss est interpolé en SQL (un identifiant n'est pas paramétrable) : on le valide
 *  strictement. Il vient de l'env (config.PGBOSS_SCHEMA), jamais d'une entrée utilisateur. */
function safeSchema(schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error(`schéma pgboss invalide: ${schema}`);
  return schema;
}

/**
 * Agrégats globaux cross-tenant pour /ops. Les files se lisent en SQL sur `<schema>.job` : l'API ne voit pas
 * l'instance pg-boss du worker.
 */
export class PgOpsStore {
  private readonly schema: string;
  constructor(private readonly pool: Pool, schema = 'pgboss') {
    this.schema = safeSchema(schema);
  }

  /** Nom d'un espace, pour le bandeau d'observation. `null` = espace inconnu. */
  async getTenantName(tenantId: string): Promise<string | null> {
    const res = await this.pool.query<{ name: string }>('select name from tenants where id = $1', [tenantId]);
    return res.rows[0]?.name ?? null;
  }

  /**
   * Pose ou retire le verrou d'un espace ; `false` si l'espace n'existe pas. Seulement `locked` et `active` :
   * déverrouiller vers `trial` ferait retomber un client payant en essai. Le verrou ferme les portes, pas le
   * travail en vol : les campagnes déjà enfilées continuent (la pause est dans le runbook de `DEPLOY.md`).
   */
  async verrouillerEspace(tenantId: string, verrouille: boolean): Promise<boolean> {
    const res = await this.pool.query(
      `update tenants set status = $2 where id = $1`,
      [tenantId, verrouille ? 'locked' : 'active'],
    );
    return (res.rowCount ?? 0) > 0;
  }

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

  /** Messages échangés par jour, tous espaces, sur les N derniers jours. */
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
   * Les jobs morts, les plus anciens d'abord, en lecture pure : on décide avant de rejouer, pour ne pas relancer
   * en masse des traitements qui ont échoué pour une raison non corrigée.
   */
  async listerJobsMorts(limite = 50): Promise<JobMortRow[]> {
    const parDlq = new Map(BASE_QUEUES.map((q) => [dlqName(q), q]));
    try {
      const res = await this.pool.query<{ id: string; name: string; data: unknown; created_on: Date; output: unknown }>(
        `select id, name, data, created_on, output
           from ${this.schema}.job
          where name = any($1) and state = 'created'
          order by created_on asc
          limit $2`,
        [[...parDlq.keys()], Math.max(1, Math.min(limite, 200))],
      );
      return res.rows.map((r) => ({
        id: r.id,
        queue: parDlq.get(r.name) ?? r.name,
        data: r.data,
        creeLe: r.created_on.toISOString(),
        // `output` porte l'erreur de la dernière tentative, tronquée : on décide sur une ligne, on enquête ailleurs.
        erreur: r.output === null || r.output === undefined ? null : JSON.stringify(r.output).slice(0, 300),
      }));
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '42P01') return [];
      throw err;
    }
  }

  /**
   * Retire de la DLQ les jobs qu'on vient de ré-enfiler. 🔴 Appelée après l'enfilement, jamais avant : un crash
   * entre les deux produit un doublon, rattrapé partout où ça compte (dédup de l'entrant, réclamation d'un
   * destinataire, verrou de run) ; l'ordre inverse produirait une perte, rattrapée nulle part.
   */
  async oublierJobsMorts(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await this.pool.query(`delete from ${this.schema}.job where id = any($1::uuid[])`, [ids]);
    return res.rowCount ?? 0;
  }

  async getQueueLoadParGroupe(limite = 20): Promise<QueueGroupLoadRow[]> {
    try {
      const res = await this.pool.query<{ name: string; group_id: string; backlog: string; age_max: string }>(
        `select name, group_id, count(*)::int as backlog,
                max(extract(epoch from (now() - start_after)))::int as age_max
           from ${this.schema}.job
          where name = any($1) and state in ('created', 'retry')
            and group_id is not null and start_after <= now()
          group by name, group_id
          having max(extract(epoch from (now() - start_after))) > 0
          order by age_max desc
          limit $2`,
        [ALL_QUEUES, Math.max(1, limite)],
      );
      return res.rows.map((r) => ({
        queue: r.name,
        groupe: r.group_id,
        backlog: Number(r.backlog),
        ageMaxSecondes: Math.max(0, Number(r.age_max)),
      }));
    } catch (err) {
      // 42P01 = table pgboss absente : pas d'erreur, rien à signaler.
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '42P01') return [];
      throw err;
    }
  }

  async getQueueLoad(): Promise<QueueLoadRow[]> {
    const zero = (): QueueLoadRow[] => ALL_QUEUES.map((q) => ({ queue: q, backlog: 0, active: 0, failed: 0, ageMaxSecondes: 0 }));
    try {
      const res = await this.pool.query<{ name: string; state: string; count: string; age_max: string | null }>(
        // `age_max` ne compte que les jobs prêts (`start_after` passé), dans le même balayage grâce au `filter`.
        // `active` est compté : un job pris et jamais fini est exactement ce qu'un indicateur de retard doit montrer.
        `select name, state, count(*)::int as count,
                max(extract(epoch from (now() - start_after)))
                  filter (where state in ('created', 'retry', 'active') and start_after <= now()) as age_max
         from ${this.schema}.job
         where name = any($1) and state in ('created', 'retry', 'active', 'failed')
         group by name, state`,
        [ALL_QUEUES],
      );
      const byQueue = new Map<string, QueueLoadRow>(ALL_QUEUES.map((q) => [q, { queue: q, backlog: 0, active: 0, failed: 0, ageMaxSecondes: 0 }]));
      for (const row of res.rows) {
        const q = byQueue.get(row.name);
        if (!q) continue;
        const c = Number(row.count);
        if (row.state === 'created' || row.state === 'retry') q.backlog += c;
        else if (row.state === 'active') q.active += c;
        else if (row.state === 'failed') q.failed += c;
        // Le `max` porte sur un état à la fois (le group by inclut `state`) : on garde le plus grand.
        const age = row.age_max === null ? 0 : Math.max(0, Math.round(Number(row.age_max)));
        if (age > q.ageMaxSecondes) q.ageMaxSecondes = age;
      }
      return ALL_QUEUES.map((q) => byQueue.get(q)!);
    } catch (err) {
      // 42P01 = undefined_table (schéma/table pgboss absent) -> pas d'erreur, juste des zéros.
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '42P01') return zero();
      throw err;
    }
  }

  /**
   * Le vrai p95 d'attente, par file, sur une fenêtre. `ageMaxSecondes` est une photo de l'instant ; un objectif
   * de service se vérifie sur une durée. Aucune instrumentation nouvelle : pg-boss horodate `start_after`,
   * `started_on` et `completed_on`, et garde les jobs terminés le temps de sa rétention.
   *
   * Une fenêtre qui contient un redémarrage de worker le mesure : les jobs qui l'ont traversé portent une
   * attente énorme et normale.
   */
  async getQueueLatence(fenetreHeures = 24): Promise<QueueLatenceRow[]> {
    const heures = Math.min(24 * 30, Math.max(1, Math.round(fenetreHeures)));
    try {
      const res = await this.pool.query<{
        name: string; n: string; p50: string | null; p95: string | null; p95_total: string | null; max_total: string | null;
      }>(
        // `started_on - start_after` = l'attente (problème de cadence ou de concurrence) ;
        // `completed_on - start_after` = le bout en bout (peut être un traitement lent).
        `select name,
                count(*)::int as n,
                percentile_cont(0.5) within group (order by extract(epoch from (started_on - start_after))) as p50,
                percentile_cont(0.95) within group (order by extract(epoch from (started_on - start_after))) as p95,
                percentile_cont(0.95) within group (order by extract(epoch from (completed_on - start_after))) as p95_total,
                max(extract(epoch from (completed_on - start_after))) as max_total
           from ${this.schema}.job
          where name = any($1)
            and state = 'completed'
            and started_on is not null and completed_on is not null
            and completed_on > now() - make_interval(hours => $2::int)
          group by name`,
        [ALL_QUEUES, heures],
      );
      const nombre = (v: string | null): number => (v === null ? 0 : Math.max(0, Math.round(Number(v) * 1000) / 1000));
      return res.rows.map((r) => ({
        queue: r.name,
        echantillons: Number(r.n),
        attenteP50Secondes: nombre(r.p50),
        attenteP95Secondes: nombre(r.p95),
        boutEnBoutP95Secondes: nombre(r.p95_total),
        boutEnBoutMaxSecondes: nombre(r.max_total),
      }));
    } catch (err) {
      // Comme `getQueueLoad` : un schéma pgboss absent est une absence de mesure, pas une panne.
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '42P01') return [];
      throw err;
    }
  }

  /**
   * Numéros à rafraîchir par le sweeper de statut, tous espaces, bornés (deux GET Graph par numéro). Tri par
   * `status_checked_at` (`nulls first`) : un tourniquet, pour que tout le parc soit relu et pas toujours les
   * mêmes premiers.
   */
  async listNumbersForStatusSweep(limit = 200): Promise<PhoneForSweepRow[]> {
    const n = Math.max(1, Math.min(1000, Math.floor(limit)));
    const res = await this.pool.query<{ id: string; tenant_id: string; waba_id: string | null; status: string | null; quality_rating: string | null }>(
      `select id, tenant_id, waba_id, status, quality_rating from phone_numbers
        order by status_checked_at asc nulls first, created_at limit $1`,
      [n],
    );
    return res.rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, wabaId: r.waba_id, status: r.status, qualityRating: r.quality_rating }));
  }

  /**
   * Combien de webhooks Meta ont été reçus (enfilés par le receveur) sur la fenêtre : le seul compteur qui reste
   * vrai quand la lecture des payloads est cassée, puisque le receveur enfile avant toute interprétation.
   */
  async webhooksRecusDepuis(minutes: number): Promise<number> {
    const n = Math.max(1, Math.min(1440, Math.floor(minutes)));
    const res = await this.pool.query<{ n: string }>(
      `select count(*)::text as n from pgboss.job
        where name = 'webhook' and created_on > now() - ($1 || ' minutes')::interval`,
      [String(n)],
    );
    return Number(res.rows[0]?.n ?? '0');
  }

  /** Combien d'événements ont été enregistrés sur la même fenêtre. */
  async evenementsWebhookDepuis(minutes: number): Promise<number> {
    const n = Math.max(1, Math.min(1440, Math.floor(minutes)));
    const res = await this.pool.query<{ n: string }>(
      `select count(*)::text as n from webhook_events
        where received_at > now() - ($1 || ' minutes')::interval`,
      [String(n)],
    );
    return Number(res.rows[0]?.n ?? '0');
  }
}
