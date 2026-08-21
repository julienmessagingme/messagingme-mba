import type { Pool } from 'pg';
import { STATS_TZ, BOUNDS_CTE } from './range';
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
  /**
   * Taps sur un bouton de RÉPONSE RAPIDE du template, attribués comme `replied` (dont ils sont un
   * sous-ensemble : un tap de bouton EST un message entrant).
   */
  buttonReplies: number;
  /**
   * Clics sur les liens TRACÉS du template de la campagne, depuis son premier envoi.
   *
   * `null` = ce template ne porte aucun bouton URL tracé et confirmé : l'étape n'est pas affichable, et une
   * barre à zéro se lirait « personne n'a cliqué » au lieu de « il n'y a rien à cliquer ».
   *
   * ⚠️ C'est un compteur de TEMPLATE, pas de campagne : un lien ne sait pas quel envoi l'a porté. Le seuil au
   * premier envoi écarte l'exploration de Meta (qui clique chaque bouton URL pendant la revue, donc AVANT le
   * premier envoi), mais deux campagnes sur le même template partagent leurs clics. L'écran doit le dire.
   */
  urlClicks: number | null;
}

/** Une ligne du breakdown d'erreurs : code Meta numérique + template + occurrences sur la plage. */
export interface ErrorBreakdownRow {
  code: number;
  count: number;
  /** Template de la campagne à l'origine des erreurs (null si non renseigné). */
  templateName: string | null;
}

/** Volume d'envois de campagne par (jour, catégorie) — base du graphe de coût estimé. */
export interface CostVolumeRow {
  date: string; // 'YYYY-MM-DD' (Europe/Paris)
  category: string; // 'marketing' | 'utility'
  count: number;
}

/**
 * Filtre optionnel du graphe de coût : DES campagnes OU DES templates. Plusieurs valeurs -> une série
 * COMPILÉE sur l'ensemble (les volumes s'additionnent jour par jour), pas la première de la liste.
 *
 * Les deux axes restent MUTUELLEMENT EXCLUSIFS côté écran : combiner « campagne A » et « template B » ne
 * décrirait pas une union mais leur intersection, qui ne veut rien dire pour un opérateur. Une liste vide
 * équivaut à « tout », comme l'absence de filtre.
 */
export interface CostFilter {
  campaignIds?: string[];
  templateNames?: string[];
}

export interface DashboardStats {
  /** CUMULATIF : total de contacts à chaque jour (dense, une valeur/jour, reporte les jours sans ajout). */
  contacts: DailyPoint[];
  templates: { utility: DailyPoint[]; marketing: DailyPoint[] };
  exchanged: DailyPoint[];
  /**
   * Messages de SERVICE : les SORTANTS qui ne sont pas des templates (réponse d'un agent depuis l'inbox,
   * message d'un scénario dans la fenêtre de 24 h). Affichés à côté des templates, parce que c'est là qu'on
   * lit ce qui est parti. Ils n'entrent PAS dans le coût estimé : Meta ne les facture pas au message, et
   * leur inventer un prix reviendrait à mentir sur la facture.
   *
   * Sous-ensemble de `exchanged`, qui compte aussi les ENTRANTS : deux lectures différentes, même requête.
   */
  service: DailyPoint[];
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
/**
 * Un message ENTRANT attribué à CET envoi : même numéro, après l'envoi, et aucun envoi ultérieur au même
 * numéro entre les deux (sinon la réponse revient au dernier envoi, pas à celui-ci). C'est ce qui empêche
 * une même réponse d'être comptée sur deux campagnes.
 *
 * Sorti en fragment parce que le funnel s'en sert DEUX fois, pour « répondu » et pour « a tapé un bouton ».
 * Deux copies divergeraient à la première correction de l'attribution. Même doctrine que
 * `RECIPIENT_FAILED_SQL` (`src/campaign/store.pg.ts`).
 *
 * ⚠️ S'utilise UNIQUEMENT dans une requête où `c` est `campaigns` et `r` est `campaign_recipients`.
 * `extra` restreint la nature du message entrant (ex. `and m.type = 'button'`).
 */
const entrantAttribue = (extra = ''): string => `r.sent_at is not null and exists (
           select 1 from conversations cv
             join conversation_messages m on m.conversation_id = cv.id
           where cv.tenant_id = c.tenant_id and not cv.is_test
             and cv.wa_id = regexp_replace(r.to_e164, '[^0-9]', '', 'g')
             and m.direction = 'in'
             and m.created_at > r.sent_at ${extra}
             and not exists (
               select 1 from campaign_recipients r2 join campaigns c2 on c2.id = r2.campaign_id
               where c2.tenant_id = c.tenant_id
                 and r2.to_e164 = r.to_e164
                 and r2.sent_at is not null
                 and r2.sent_at > r.sent_at
                 and r2.sent_at < m.created_at
             )
         )`;

export class PgStatsStore {
  constructor(private readonly pool: Pool) {}

  async getDashboard(tenantId: string, range: DateRange): Promise<DashboardStats> {
    const { from, to } = range;

    // 1) Contacts CUMULÉS / jour : total courant = baseline (contacts créés AVANT la plage) +
    //    somme courante des nouveaux/jour. Série DENSE (generate_series de from à to) pour que les jours
    //    sans nouvel ajout reportent le total (pas de retour à 0), sans logique côté front.
    const contacts = await this.pool.query<{ d: string; count: string }>(
      `with ${BOUNDS_CTE},
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
      `with ${BOUNDS_CTE}
       select d, category, sum(cnt)::int as count from (
         select to_char(date_trunc('day', r.sent_at at time zone $4), 'YYYY-MM-DD') d, c.category, count(*) cnt
         from campaign_recipients r join campaigns c on c.id = r.campaign_id, bounds b
         where c.tenant_id = $1 and r.status = 'sent' and r.sent_at >= b.start_ts and r.sent_at < b.end_ts
           and (r.delivery_status is null or r.delivery_status <> 'failed')
         group by d, c.category
         union all
         select to_char(date_trunc('day', m.created_at at time zone $4), 'YYYY-MM-DD') d, m.template_category, count(*) cnt
         from conversation_messages m join conversations cv on cv.id = m.conversation_id, bounds b
         where cv.tenant_id = $1 and not cv.is_test and m.direction = 'out' and m.type = 'template'
           and m.template_category is not null and m.created_at >= b.start_ts and m.created_at < b.end_ts
           -- Anti double-compte : un template de campagne DIRECTE est déjà compté via campaign_recipients (Pièce 0
           -- le logge aussi dans conversation_messages, même wamid) -> on l'exclut ici. Les envois inbox manuels
           -- (jamais dans campaign_recipients) et workflow (message_id synthétique wf-..., jamais le vrai wamid) sont gardés.
           and not exists (
             select 1 from campaign_recipients r2 join campaigns c2 on c2.id = r2.campaign_id
             where c2.tenant_id = cv.tenant_id and r2.message_id = m.meta_message_id
           )
         group by d, m.template_category
       ) x group by d, category order by d`,
      [tenantId, from, to, TZ],
    );

    // 3) Messages hors template / jour. UNE requête pour deux lectures : les ÉCHANGÉS (entrants + sortants)
    //    et, dans le même passage, les seuls SORTANTS, qui sont les messages de service. Un second balayage de
    //    la même table pour un sous-ensemble ne serait qu'un coût de plus.
    const exchanged = await this.pool.query<{ d: string; count: string; sortants: string }>(
      `with ${BOUNDS_CTE}
       select to_char(date_trunc('day', m.created_at at time zone $4), 'YYYY-MM-DD') as d,
              count(*)::int as count,
              count(*) filter (where m.direction = 'out')::int as sortants
       from conversation_messages m join conversations cv on cv.id = m.conversation_id, bounds b
       where cv.tenant_id = $1 and not cv.is_test and m.created_at >= b.start_ts and m.created_at < b.end_ts
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
      service: exchanged.rows.map((r) => ({ date: r.d, count: Number(r.sortants) })),
    };
  }

  /**
   * Volume par template envoyé sur la période (campagnes + envois inbox), pour le dropdown du
   * dashboard et le prix estimé. Exclut les livraisons en échec (delivery_status='failed').
   */
  async getTemplateBreakdown(tenantId: string, range: DateRange): Promise<TemplateBreakdownRow[]> {
    const { from, to } = range;
    const res = await this.pool.query<{ name: string; category: string | null; count: string }>(
      `with ${BOUNDS_CTE}
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
         where cv.tenant_id = $1 and not cv.is_test and m.direction = 'out' and m.type = 'template'
           and m.template_name is not null and m.created_at >= b.start_ts and m.created_at < b.end_ts
           -- Anti double-compte : template de campagne directe déjà compté via campaign_recipients (même wamid).
           and not exists (
             select 1 from campaign_recipients r2 join campaigns c2 on c2.id = r2.campaign_id
             where c2.tenant_id = cv.tenant_id and r2.message_id = m.meta_message_id
           )
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
    const res = await this.pool.query<{ sent: string; delivered: string; read: string; replied: string; failed: string; button_replies: string }>(
      `select
         count(r.id) filter (where r.status = 'sent' and r.delivery_status is distinct from 'failed')::int as sent,
         count(r.id) filter (where r.delivery_status in ('delivered', 'read'))::int as delivered,
         count(r.id) filter (where r.delivery_status = 'read')::int as read,
         count(r.id) filter (where r.status = 'failed' or r.delivery_status = 'failed')::int as failed,
         count(r.id) filter (where ${entrantAttribue()})::int as replied,
         -- Sous-ensemble des repondants, restreint aux taps de bouton. On teste type = 'button' et NON
         -- button_payload is not null : ce champ est aussi rempli par un message interactive et par une
         -- reaction (ou il porte un identifiant de message), donc un emoji serait compte comme un clic.
         count(r.id) filter (where ${entrantAttribue("and m.type = 'button'")})::int as button_replies
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
      buttonReplies: Number(row?.button_replies ?? 0),
      urlClicks: await this.clicsLiensCampagne(tenantId, campaignId),
    };
  }

  /**
   * Clics sur les liens tracés du template de CETTE campagne, à partir de son PREMIER envoi.
   *
   * `null` quand le template ne porte aucun lien tracé confirmé (ou quand la campagne est un scénario, dont
   * `template_name` est nul) : il n'y a alors rien à afficher, et une barre à zéro mentirait.
   *
   * Le seuil au premier envoi n'est pas cosmétique : Meta explore puis fait cliquer chaque bouton URL pendant
   * la revue du template, donc AVANT le moindre envoi. Sans lui, une campagne démarre avec des dizaines de
   * clics qui ne viennent de personne. Le filtre d'agent (`src/links/clic-automatique.ts`) attrape la même
   * chose à l'écriture ; ce seuil couvre en plus tout ce qui a été enregistré avant qu'il n'existe.
   */
  private async clicsLiensCampagne(tenantId: string, campaignId: string): Promise<number | null> {
    const res = await this.pool.query<{ n: string | null }>(
      `with borne as (
         select c.template_name, c.template_language, min(r.sent_at) as premier_envoi
           from campaigns c join campaign_recipients r on r.campaign_id = c.id
          where c.id = $1 and c.tenant_id = $2 and r.sent_at is not null
          group by c.template_name, c.template_language
       )
       select count(k.id)::int as n
         from borne b
         join tracked_links l
           on l.tenant_id = $2
          and l.template_name = b.template_name
          and l.template_language = b.template_language
          and l.confirmed_at is not null
         left join tracked_link_clicks k
           on k.code = l.code and k.tenant_id = $2 and k.at >= b.premier_envoi
        where b.template_name is not null
        -- GROUP BY indispensable : un count d agregat SANS group by rend TOUJOURS une ligne (a zero),
        -- donc 'aucun lien trace' serait devenu '0 clic', et l ecran afficherait une etape qui ment.
        -- Avec lui, zero ligne en entree = zero ligne en sortie = null cote appelant.
        group by b.template_name`,
      [campaignId, tenantId],
    );
    // Aucune ligne = pas de lien tracé confirmé sur ce template (ou campagne jamais envoyée) -> non affichable.
    const row = res.rows[0];
    return row ? Number(row.n ?? 0) : null;
  }

  /**
   * Breakdown des codes d'erreur Meta sur la plage (campagnes du tenant). Ancré sur
   * coalesce(delivery_updated_at, sent_at, claimed_at) pour capter à la fois les échecs de LIVRAISON
   * (delivery_updated_at) et d'ENVOI (claimed_at, sent_at null). Trié par occurrences décroissantes.
   */
  async getErrorBreakdown(tenantId: string, range: DateRange, templateName?: string): Promise<ErrorBreakdownRow[]> {
    const { from, to } = range;
    const res = await this.pool.query<{ code: number; template_name: string | null; count: string }>(
      `with ${BOUNDS_CTE}
       select r.error_code as code, c.template_name as template_name, count(*)::int as count
       from campaign_recipients r join campaigns c on c.id = r.campaign_id, bounds b
       where c.tenant_id = $1 and r.error_code is not null
         and coalesce(r.delivery_updated_at, r.sent_at, r.claimed_at) >= b.start_ts
         and coalesce(r.delivery_updated_at, r.sent_at, r.claimed_at) < b.end_ts
         and ($5::text is null or c.template_name = $5::text)
       group by r.error_code, c.template_name
       order by count desc, code asc`,
      [tenantId, from, to, TZ, templateName ?? null],
    );
    return res.rows.map((r) => ({ code: Number(r.code), count: Number(r.count), templateName: r.template_name }));
  }

  /**
   * Volume d'envois de campagne par (jour Paris, catégorie) sur la plage, filtrable par campagne OU
   * template. Base du graphe de coût estimé (multiplié ensuite par le tarif Meta de la catégorie).
   * N'inclut que les envois réussis (status='sent', livraison non 'failed'), ancrés sur sent_at.
   */
  async getCostVolume(tenantId: string, range: DateRange, filter: CostFilter): Promise<CostVolumeRow[]> {
    const { from, to } = range;
    const res = await this.pool.query<{ date: string; category: string; count: string }>(
      `with ${BOUNDS_CTE}
       select to_char(r.sent_at at time zone $4, 'YYYY-MM-DD') as date, c.category as category, count(*)::int as count
       from campaign_recipients r join campaigns c on c.id = r.campaign_id, bounds b
       where c.tenant_id = $1
         and r.status = 'sent' and r.delivery_status is distinct from 'failed'
         and r.sent_at >= b.start_ts and r.sent_at < b.end_ts
         and ($5::uuid[] is null or c.id = any($5::uuid[]))
         and ($6::text[] is null or c.template_name = any($6::text[]))
       group by 1, 2`,
      // Liste VIDE -> null, pas un tableau vide : `= any('{}')` ne matche rien, donc un filtre vide effacerait
      // le graphe au lieu de le laisser complet.
      [
        tenantId, from, to, TZ,
        filter.campaignIds?.length ? filter.campaignIds : null,
        filter.templateNames?.length ? filter.templateNames : null,
      ],
    );
    return res.rows.map((r) => ({ date: r.date, category: r.category, count: Number(r.count) }));
  }
}
