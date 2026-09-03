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

/** Charge d'une file pg-boss : en attente (created+retry), actifs, échoués. Signal VPS -> Railway. */
export interface QueueLoadRow {
  queue: string;
  backlog: number;
  active: number;
  failed: number;
  /**
   * Âge, en secondes, du plus vieux job PRÊT à partir et pas encore pris. `0` quand il n'y en a aucun.
   *
   * 🔴 C'est LA mesure qui dit si on tient la cadence, et la profondeur ne la remplace pas : mille jobs
   * avalés en trois secondes vont bien, dix jobs qui attendent depuis un quart d'heure vont mal. C'est aussi
   * le seul indicateur qui rende observables les objectifs de service (`docs/SLO-2026-09-01.md`).
   *
   * ⚠️ « PRÊT » compte : un job programmé pour plus tard n'est pas en retard, il attend son heure. On mesure
   * donc depuis `start_after`, pas depuis la création, sinon un rappel prévu dans trois jours afficherait
   * trois jours de retard et rendrait la mesure inutilisable.
   */
  ageMaxSecondes: number;
}

/**
 * Le plus vieux job en attente d'UN GROUPE de file. Sert l'équité (SLO 3 de `docs/SLO-2026-09-01.md`).
 *
 * 🔴 Pourquoi il fallait ça EN PLUS de l'âge par file : la profondeur et l'âge globaux disent « la file
 * avance », pas « tout le monde est servi ». Un espace affamé derrière un espace bavard est parfaitement
 * invisible d'une moyenne, et l'équité est justement la promesse la plus facile à trahir sans s'en
 * apercevoir. C'est le trou que le document de SLO signalait comme son propre angle mort.
 *
 * ⚠️ CE QUE `groupe` DÉSIGNE DÉPEND DE LA FILE, et il ne faut pas le lire de travers :
 *   - `campaign-run` : l'ESPACE client (c'est là que se lit l'équité entre clients) ;
 *   - `webhook` : le CONTACT (`<numéro>:<wa_id>`), donc « quel contact attend le plus », ce qui sert le SLO 1 ;
 *   - les autres files n'ont pas de groupe : elles n'apparaissent pas ici.
 */
/**
 * La latence RÉELLE d'une file sur une fenêtre, calculée sur les jobs terminés.
 *
 * `echantillons` est la première chose à regarder : un p95 sur trois jobs ne veut rien dire, et la rétention
 * de pg-boss décide de ce qui reste lisible. Un p95 sans son effectif est un chiffre qui trompe.
 */
export interface QueueLatenceRow {
  queue: string;
  echantillons: number;
  /** Temps pendant lequel PERSONNE ne s'occupait du job (cadence de sondage, concurrence saturée). */
  attenteP50Secondes: number;
  attenteP95Secondes: number;
  /** Attente PLUS traitement : ce que l'utilisateur ressent réellement. */
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
 * Un job MORT, en attente d'une décision humaine. Il a épuisé ses rejeux et personne ne consomme les DLQ :
 * sans rejeu manuel, il y reste pour toujours.
 *
 * 🔴 Pour un `webhook`, ça veut dire un MESSAGE DE CLIENT jamais traité. C'est le pire cas de tout ce dépôt,
 * parce qu'il est silencieux : le client a écrit, le scénario n'a pas avancé, et personne ne le sait.
 */
export interface JobMortRow {
  id: string;
  /** La file d'ORIGINE (sans le suffixe), c'est-à-dire celle où le rejeu le remettra. */
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
  /** Nom d'un espace, pour l'afficher dans le bandeau d'observation. `null` = espace inconnu. */
  async getTenantName(tenantId: string): Promise<string | null> {
    const res = await this.pool.query<{ name: string }>('select name from tenants where id = $1', [tenantId]);
    return res.rows[0]?.name ?? null;
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
  /**
   * Les groupes qui ATTENDENT le plus, toutes files confondues. Vide quand rien n'attend, ce qui est l'état
   * normal : cette lecture n'existe que pour rendre visible ce qu'une moyenne cache.
   *
   * Borné à `limite` lignes, triées par âge décroissant : on veut les pires, pas un inventaire. Un espace
   * qui n'apparaît pas est un espace qui va bien.
   */
  /**
   * Les jobs MORTS, les plus anciens d'abord. Lecture pure : rien n'est déplacé ni supprimé.
   *
   * C'est ce qui permet de décider AVANT de rejouer. Rejouer sans regarder, c'est relancer en masse des
   * traitements qui ont échoué pour une raison qu'on n'a pas corrigée.
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
        // `output` porte l'erreur de la dernière tentative. Tronquée : un opérateur décide sur une ligne,
        // il enquête ailleurs, et une pile complète par job rendrait l'écran illisible.
        erreur: r.output === null || r.output === undefined ? null : JSON.stringify(r.output).slice(0, 300),
      }));
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '42P01') return [];
      throw err;
    }
  }

  /**
   * Retire de la DLQ les jobs qu'on vient de RÉ-ENFILER. Appelée APRÈS l'enfilement, jamais avant.
   *
   * 🔴 L'ordre décide du mode de panne, et il est choisi. Enfiler puis supprimer veut dire qu'un crash entre
   * les deux produit un DOUBLON ; supprimer puis enfiler produirait une PERTE. Le doublon est rattrapé
   * partout où ça compte (déduplication du message entrant, réclamation atomique d'un destinataire, verrou de
   * run), la perte ne l'est nulle part. On choisit donc le doublon, en le sachant.
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
        // `age_max` ne compte QUE les jobs prêts : un job programmé pour plus tard (`start_after` futur) n'est
        // pas en retard. Le `filter` le fait dans le même passage, donc sans second balayage de la table.
        //
        // 🔴 `active` EST COMPTÉ, et c'était le défaut (constat A4 de l'audit externe du 2026-09-02). En
        // n'écoutant que `created` et `retry`, la mesure retombait à ZÉRO à l'instant où un job était PRIS,
        // même s'il restait bloqué dix minutes dedans. Le document de SLO affirmait de cette jauge qu'elle
        // était « le pire cas instantané, donc plus sévère : s'il tient, le p95 tient ». C'était faux dans
        // le seul cas qui compte, celui où quelque chose est coincé. Un job pris et jamais fini est
        // exactement ce qu'un indicateur de retard doit montrer.
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
        // Le `max` porte sur UN état à la fois (le group by inclut `state`) : on garde le plus grand des trois
        // lignes possibles, `created`, `retry` et `active`.
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
   * LE VRAI p95 D'ATTENTE, PAR FILE, SUR UNE FENÊTRE (constat A4 de l'audit externe du 2026-09-02).
   *
   * 🔴 POURQUOI IL FALLAIT AUTRE CHOSE QUE LA JAUGE. `ageMaxSecondes` est une photo : elle dit ce qui attend
   * MAINTENANT. Le document de SLO s'en servait comme d'un p95 (« plus sévère : s'il tient, le p95 tient »),
   * ce qui est faux dans les deux sens : elle ne voit rien d'une lenteur passée qui s'est résorbée, et elle
   * ne voyait pas non plus un job coincé en traitement. Un objectif de service se vérifie sur une DURÉE.
   *
   * ⚠️ AUCUNE INSTRUMENTATION NOUVELLE. pg-boss horodate déjà `start_after` (le moment où le job devient
   * exigible), `started_on` (sa prise) et `completed_on` (sa fin), et garde les jobs terminés dans la même
   * table le temps de sa rétention. Ajouter nos propres colonnes aurait dupliqué ce que la base sait déjà.
   *
   * ⚠️ CE QUE LA FENÊTRE INCLUT, ELLE LE MESURE. Une fenêtre qui contient un redémarrage de worker mesure
   * le redémarrage : les jobs qui l'ont traversé portent une attente énorme et parfaitement normale. C'est
   * une force autant qu'un piège, parce que c'est précisément ce que la jauge ne pouvait pas montrer.
   */
  async getQueueLatence(fenetreHeures = 24): Promise<QueueLatenceRow[]> {
    const heures = Math.min(24 * 30, Math.max(1, Math.round(fenetreHeures)));
    try {
      const res = await this.pool.query<{
        name: string; n: string; p50: string | null; p95: string | null; p95_total: string | null; max_total: string | null;
      }>(
        // `started_on - start_after` = l'ATTENTE (le temps où personne ne s'occupait du job).
        // `completed_on - start_after` = le BOUT EN BOUT, qui est ce que l'utilisateur ressent.
        // Les deux, parce qu'ils ne se corrigent pas au même endroit : l'attente est un problème de cadence
        // ou de concurrence, le bout en bout peut être un traitement lent.
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
      // Même traitement que `getQueueLoad` : un schéma pgboss absent n'est pas une panne, c'est une absence
      // de mesure. Une carte vide vaut mieux qu'une page d'exploitation qui refuse de s'afficher.
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '42P01') return [];
      throw err;
    }
  }

  /**
   * Numéros à rafraîchir par le sweeper de statut (item 4.10), CROSS-TENANT (lecture seule stricte, comme le
   * reste de ce store). C'est la seule lecture cross-tenant de phone_numbers du store d'ops. BORNÉE : le pull
   * fait 2 GET Graph par numéro, LIMIT protège le budget si le parc grandit.
   *
   * 🔴 TOURNIQUET par ancienneté de RELEVÉ (lot 7 du programme II). L'ordre était `created_at`, donc au-delà
   * du 200e numéro un numéro n'était JAMAIS relu : ni sa qualité, ni son palier, ni la révocation de son
   * jeton n'étaient surveillés, et c'étaient toujours les 200 mêmes qu'on relisait. Trier par
   * `status_checked_at` fait passer en queue celui qu'on vient de lire : tout le parc finit par tourner.
   * `nulls first` = jamais relevé, donc prioritaire.
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
}
