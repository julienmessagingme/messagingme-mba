import type { Pool } from 'pg';
import { STATS_TZ, BOUNDS_CTE } from './range';
import type { DateRange } from './range';
// Type seul : `cost.ts` importe déjà des types d'ici, un import de valeur dans l'autre sens ferait un cycle.
import type { VolumeCampagneRow } from './cost';
// Valeur partagée : le plafond doit être le même des deux côtés (le SQL en garde une de plus, la fonction pure
// tranche et l'annonce).
import { PLAFOND_CAMPAGNES_SYNTHESE } from './cost';
import { ORIGINE_EFFECTIVE_SQL, THEME_DE_ORIGINE, DETAIL_IA } from '../inbox/origine';
import { RECIPIENT_FAILED_SQL, INSTANT_ECHEC_SQL } from '../campaign/echecs-sql';
import { horsEntreeGratuite } from './entree-gratuite';
import { dureeConservationSql } from '../inbox/retention';
import { DROITS, GRACE_RETOUR_BASE_JOURS } from '../offres/offres';
import type { NodeEventCount } from '../workflow/node-events.pg';
import type { EnvoisCampagneRow } from './cout-campagne';
import type { CanalEtage } from '../campaign/etages';

export interface DailyPoint {
  date: string; // 'YYYY-MM-DD' (Europe/Paris)
  count: number;
}

/**
 * Funnel d'une campagne : envoyés -> délivrés -> lus -> répondus (message entrant après l'envoi), et échecs.
 *
 * Deux grains : tous les compteurs et `contactsVises` comptent des personnes (`campaign_recipients`), `parCanal`
 * compte des tentatives (`campaign_envois`). Sa somme dépasse légitimement `contactsVises` dès qu'une chaîne de
 * repli a fait deux tentatives pour la même personne.
 */
export interface CampaignFunnel {
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  /**
   * Envois partis dont Meta n'a jamais rendu d'accusé : ni `delivered` ni `read` ne les comptent, ce qui ne veut
   * pas dire « non délivrés ». Systématique pour une campagne à scénario : la branche scénario enregistre un
   * identifiant synthétique (`wf-…`) que l'accusé de Meta, qui porte le vrai `wamid`, ne peut pas apparier. Sans
   * ce compte, l'écran afficherait un zéro là où il n'y a pas de mesure.
   */
  sansAccuse: number;
  /**
   * Taps sur un bouton de réponse rapide du template, attribués comme `replied` (dont ils sont un
   * sous-ensemble : un tap est un message entrant).
   */
  buttonReplies: number;
  /**
   * Clics sur les liens tracés du template de la campagne, depuis son premier envoi. `null` = aucun bouton URL
   * tracé : une barre à zéro se lirait « personne n'a cliqué » au lieu de « rien à cliquer ».
   *
   * Compteur de template, pas de campagne : un lien ne sait pas quel envoi l'a porté, et deux campagnes sur le
   * même template partagent leurs clics (l'écran doit le dire). Le seuil au premier envoi écarte l'exploration
   * de Meta, qui clique chaque bouton URL pendant la revue.
   */
  urlClicks: number | null;
  /**
   * Combien d'humains cette campagne a visés, quel que soit le nombre de tentatives : la ligne de tête, qui ne
   * se déduit pas de `parCanal`. Le grain est garanti par `unique (campaign_id, contact_id)`.
   */
  contactsVises: number;
  /**
   * La ventilation par canal, lue sur le journal des tentatives (`campaign_envois`), une ligne par canal
   * réellement emprunté dans l'ordre des étages. Elle peut être vide alors que la campagne a envoyé (tentatives
   * antérieures au journal) : l'écran la tait plutôt que d'annoncer « aucun envoi ».
   */
  parCanal: FunnelCanal[];
}

/** Les compteurs d'un canal d'une campagne, au grain tentative (une personne peut en avoir plusieurs). */
export interface FunnelCanal {
  canal: CanalEtage;
  /** Toutes les tentatives de ce canal, quel qu'en soit le verdict (parties, échouées, écartées). */
  envois: number;
  /** Celles qui sont vraiment parties : même définition que `sent` du funnel global. */
  reussis: number;
  delivres: number;
  lus: number;
  repondus: number;
  /**
   * Tentatives parties dont Meta n'a rendu aucun accusé, pour ce canal. La distinction « zéro » contre « on ne
   * sait pas » s'applique par canal, sinon un canal sans accusé afficherait un « 0 délivré » crédible.
   */
  sansAccuse: number;
}

/** Une ligne du breakdown d'erreurs : code Meta numérique + template + occurrences sur la plage. */
export interface ErrorBreakdownRow {
  code: number;
  count: number;
  /** Template de la campagne à l'origine des erreurs (null si non renseigné). */
  templateName: string | null;
  /**
   * La campagne d'où viennent ces erreurs, jamais nulle : seule `campaign_recipients` porte une erreur (voir
   * `getErrorBreakdown`). Une ligne par (code, template, campagne) : l'écran agrège par code et peut filtrer
   * par campagne sans redemander au serveur.
   */
  campaignId: string;
  campaignName: string;
}


/** Volume d'envois de campagne par (jour, catégorie), base du graphe de coût estimé. */
export interface CostVolumeRow {
  date: string; // 'YYYY-MM-DD' (Europe/Paris)
  /**
   * 'marketing' | 'utility' | null : d'anciens envois de scénario n'ont pas de catégorie, et
   * `estimateCostSeries` les ignore. Le type le dit : c'est la valeur que l'écran doit rendre visible.
   */
  category: string | null;
  count: number;
}

/**
 * Le filtre commun des écrans d'Analytics : des campagnes ou des templates. Plusieurs valeurs -> un résultat
 * compilé sur l'ensemble ; une liste vide équivaut à « tout ». Les deux axes restent exclusifs côté écran (leur
 * combinaison serait une intersection sans sens). Côté coût, l'axe template ramène aussi les envois hors
 * campagne, alors qu'aucune erreur n'existe hors campagne.
 */
export interface FiltreCampagneOuTemplate {
  campaignIds?: string[];
  templateNames?: string[];
}

/** Ce qui est parti et ce qui est arrivé sur un canal, sur la fenêtre (cartes de l'Accueil). */
export interface VolumeCanal {
  envoyes: number;
  recus: number;
}

/**
 * Les volumes des deux canaux de messagerie. Un zéro ici est mesuré ; l'écran n'affiche rien quand il n'a pas
 * de réponse, jamais un zéro.
 */
export interface VolumesParCanal {
  whatsapp: VolumeCanal;
  rcs: VolumeCanal;
}

export interface DashboardStats {
  /** Cumulatif : total de contacts à chaque jour (dense, une valeur/jour, reporte les jours sans ajout). */
  contacts: DailyPoint[];
  /**
   * Les contacts encore dans le mini-CRM ce jour-là. Deux questions différentes : les cumulés disent ce qu'on a
   * collecté, les actifs ce qu'on a encore, et l'écart est l'information.
   */
  contactsActifs: DailyPoint[];
  templates: { utility: DailyPoint[]; marketing: DailyPoint[] };
  exchanged: DailyPoint[];
  /**
   * Messages de service : les sortants qui ne sont pas des templates (réponse depuis l'inbox, message de
   * scénario dans la fenêtre de 24 h). Hors du coût estimé des templates (`estimateCostSeries`). Sous-ensemble
   * de `exchanged`, qui compte aussi les entrants.
   */
  service: DailyPoint[];
  /**
   * Les mêmes messages de service, ventilés par ce qui les a écrits : l'IA (notre agent, celui de Meta, un agent
   * MCP), le scripté, l'humain, et `indeterminee` pour rendre visible un chemin d'écriture qui aurait oublié de
   * poser son origine. Le total égale la somme de `service` sur la période.
   */
  serviceParOrigine: { ia: number; scenario: number; humain: number; indeterminee: number };
  /**
   * Le détail sous « IA » : `agent + mba + mcp` égale `serviceParOrigine.ia` (tenu par un test), les deux étant
   * dérivés de la même boucle. Exact seulement depuis `BASCULE_ORIGINE` : avant, tout est rangé en `scenario`,
   * ce qui est juste puisqu'aucun tour d'agent n'existait alors.
   */
  serviceIaDetail: { agent: number; mba: number; mcp: number };
}

/**
 * Les envois de template facturables de la période, en un seul fragment : le graphe de coût et le tableau
 * « Détail par template » doivent compter la même population (templates de campagne, de scénario et d'inbox).
 * S'utilise seulement dans une requête qui déclare `${BOUNDS_CTE}` et passe `$1` = tenantId.
 *
 * Une ligne par envoi : `sent_at` pour le découpage par jour, et `campaign_id` : celui de la campagne pour un
 * envoi de campagne, celui de la campagne scénario qui a démarré le parcours pour un envoi de scénario
 * (attribution à la lecture, sans borne basse : tous les envois de scénario ultérieurs d'un contact lui sont
 * attribués), `null` si le contact n'a jamais reçu de campagne scénario. Ce `null` fait sortir la ligne d'un
 * filtre par campagne (`= any($5)` vaut NULL), alors qu'un filtre par template la garde : les deux sont voulus.
 *
 * Asymétrie réelle : un échec de livraison n'est suivi que côté campagne (`delivery_status`), un template de
 * scénario refusé après coup reste compté.
 *
 * L'attribution est optionnelle : sa sous-requête corrélée n'est servie par aucun index
 * (`cv.wa_id = regexp_replace(r3.to_e164, ...)`), et `getTemplateBreakdown`, qui jette la colonne, ne la paie
 * pas.
 */
const ATTRIBUTION_CAMPAGNE_SCENARIO = `(
           -- 🔴 ATTRIBUTION A LA LECTURE, decidee par Julien le 2026-09-07. Un envoi de template fait DANS
           -- un scenario n'ecrit nulle part la campagne qui l'a declenche : le parcours n'est enregistre
           -- qu'APRES son premier envoi ("src/workflow/executor.ts", "apply" puis "runs.start"), donc au
           -- moment d'ecrire ce message il n'existe encore rien a interroger. On le rattache donc ici.
           --
           -- MEME DOCTRINE que le « repondu » du funnel ("entrantAttribue" plus bas) : meme numero,
           -- posterieur, et le PLUS RECENT avant lui, ce qui exprime « aucun autre depart intercale ».
           -- La normalisation du numero est celle du depot ("regexp_replace"), pas une variante.
           --
           -- 🔴 "c3.workflow_id is not null" est le discriminant qui rend l'heuristique tenable : seule une
           -- campagne de type SCENARIO peut avoir engendre un envoi de scenario. Une campagne a template
           -- DIRECT envoie elle-meme, et son envoi est deja compte par la branche du dessus ; l'autoriser
           -- ici lui attribuerait en plus les envois d'un scenario declenche par tout autre chose.
           --
           -- ⚠️ CE QUE CETTE ATTRIBUTION NE SAIT PAS FAIRE, et il faut le savoir en lisant le chiffre :
           -- deux campagnes scenario visant le MEME contact a peu d'intervalle peuvent se voler un envoi.
           -- Acceptable ici (c'est deja le compromis retenu pour le funnel), et le seul moyen de faire
           -- mieux serait d'ecrire l'attribution a l'envoi, ce qui traverse le chemin chaud.
           select r3.campaign_id
           from campaign_recipients r3 join campaigns c3 on c3.id = r3.campaign_id
           where c3.tenant_id = cv.tenant_id
             and c3.workflow_id is not null
             and r3.sent_at is not null
             -- 🔴 ON SE CALE SUR "claimed_at", ET C EST UNE BORNE STRUCTURELLE, PAS UNE CONSTANTE.
             -- "sent_at" ne convient pas : le moteur journalise le message dans le fil AVANT de marquer
             -- le destinataire envoye. Mesure sur la campagne reelle « Formation du 3 » du 2026-09-03,
             -- les quatre messages precedent leur ligne de campagne de 55 a 90 ms. Un predicat
             -- "r3.sent_at <= m.created_at" excluait donc EXACTEMENT les envois a rattacher, 1 sur 4.
             --
             -- ⚠️ Une premiere version compensait par une tolerance de 5 secondes. C etait un nombre
             -- choisi, pas mesure : l ecart entre l ecriture du message et "sent_at" contient tout le
             -- reste de la chaine synchrone du scenario, qu aucune borne ne limite. Et une fenetre qui
             -- deborde vers le futur laisse une campagne partie APRES le message le voler.
             --
             -- "claimed_at" est pose par "PgCampaignStore.claim" a la transition pending -> sending,
             -- donc AVANT que le moteur ne demarre le parcours, et "markResult" ne l efface pas. Tout
             -- message ecrit par ce parcours lui est posterieur, y compris ceux des etapes suivantes.
             -- "coalesce" parce que la colonne n existe que depuis la migration 0008.
             and coalesce(r3.claimed_at, r3.sent_at) <= m.created_at
             and cv.wa_id = regexp_replace(r3.to_e164, '[^0-9]', '', 'g')
           order by coalesce(r3.claimed_at, r3.sent_at) desc
           limit 1
         )`;

/** Sans attribution : la colonne existe pour aligner les deux branches du `union all`, et vaut null. */
const SANS_ATTRIBUTION = 'null::uuid';

const envoisTemplateFacturables = (attribution: string): string => `
  select r.sent_at as sent_at, c.template_name as name, c.category as category, c.id as campaign_id
  from campaign_recipients r join campaigns c on c.id = r.campaign_id, bounds b
  where c.tenant_id = $1 and nullif(c.template_name, '') is not null and r.status = 'sent'
    and c.channel = 'whatsapp'
    and r.sent_at >= b.start_ts and r.sent_at < b.end_ts
    and (r.delivery_status is null or r.delivery_status <> 'failed')
    and ${horsEntreeGratuite('r.message_id', 'c.tenant_id')}
  union all
  select m.created_at as sent_at, m.template_name as name, m.template_category as category,
         ${attribution} as campaign_id
  from conversation_messages m join conversations cv on cv.id = m.conversation_id, bounds b
  where cv.tenant_id = $1 and not cv.is_test and m.direction = 'out' and m.type = 'template'
    and m.template_name is not null and m.created_at >= b.start_ts and m.created_at < b.end_ts
    -- Anti double-compte : template de campagne directe déjà compté par la branche du dessus (même wamid).
    and not exists (
      select 1 from campaign_recipients r2 join campaigns c2 on c2.id = r2.campaign_id
      where c2.tenant_id = cv.tenant_id and r2.message_id = m.meta_message_id
    )
    and ${horsEntreeGratuite('m.meta_message_id', 'cv.tenant_id')}`;

/** Un template envoyé sur la période, avec son volume (pour le dropdown + le prix estimé). */
export interface TemplateBreakdownRow {
  name: string;
  category: string | null; // 'marketing' | 'utility' | null (envoi inbox sans catégorie)
  count: number;
}

const TZ = STATS_TZ;

/**
 * La fenêtre d'attribution d'une campagne : sept jours après l'envoi reçu par le contact. Une seule écriture
 * pour les clics et les réponses (`engagementsParCampagne`) et les messages de service (`servicesParCampagne`) :
 * numérateur et dénominateur du coût par engagement doivent parler de la même population sur la même fenêtre.
 * `clicsParCampagne` n'a pas de fenêtre (depuis le premier envoi). Fragment SQL à interpoler ;
 * `FENETRE_BASCULE_MS` est une autre fenêtre, de même durée par hasard.
 */
export const FENETRE_IMPUTATION = "interval '7 days'";

/**
 * « Aucun départ intercalé », lu sur les lignes de destinataire (`campaign_recipients`), qui portent tout
 * l'historique. `exclure` est obligatoire dès que l'ancrage n'est pas `r.sent_at` lui-même : ancrée sur sa
 * propre colonne la ligne s'auto-exclut, ancrée sur `e.sent_at` elle se compare à un instant voisin posé par une
 * autre horloge (JS pour `markResult`, `now()` pour le journal), et le verdict dépendrait du signe de l'écart.
 */
const aucunDepartDestinataire = (instant: string, numero: string, exclure?: string): string => `not exists (
               select 1 from campaign_recipients r2 join campaigns c2 on c2.id = r2.campaign_id
               where c2.tenant_id = c.tenant_id
                 and r2.to_e164 = ${numero}${exclure ? `
                 and r2.id <> ${exclure}` : ''}
                 and r2.sent_at is not null
                 and r2.sent_at > ${instant}
                 and r2.sent_at < m.created_at
             )`;

/**
 * « Aucun départ intercalé », lu sur le journal des tentatives (`campaign_envois`). Elle complète la
 * précédente : `campaign_recipients` n'a qu'une ligne par contact et ne voit pas qu'un destinataire est reparti
 * (relance, étage suivant), et sans cette garde une même réponse serait comptée sur deux tentatives. Seule une
 * tentative réellement partie (`statut = 'sent'`) s'intercale. Le journal est best-effort : la garde du dessus
 * reste, et les deux ensemble tiennent `somme(repondus) <= replied`.
 */
const aucunDepartJournalise = (instant: string, numero: string): string => `not exists (
               select 1 from campaign_envois e2
                 join campaign_recipients r3 on r3.id = e2.recipient_id
                 join campaigns c3 on c3.id = e2.campaign_id
               where c3.tenant_id = c.tenant_id
                 and r3.to_e164 = ${numero}
                 and e2.statut = 'sent'
                 and e2.sent_at > ${instant}
                 and e2.sent_at < m.created_at
             )`;

/**
 * Un message entrant attribué à cet envoi : même numéro, après l'envoi, sur un canal par lequel cet envoi est
 * réellement passé (`predicatCanal`), et aucun envoi ultérieur au même numéro entre les deux (sinon la réponse
 * revient au dernier envoi). C'est ce qui empêche une même réponse d'être comptée sur deux campagnes, et une
 * suggestion RCS d'être comptée comme réponse à un template WhatsApp.
 *
 * Fragment partagé (« répondu » et « a tapé un bouton »). S'utilise seulement là où `c` est `campaigns` et `r`
 * `campaign_recipients`. `extra` restreint la nature du message entrant (ex. `and m.type = 'button'`).
 */
const entrantAttribueDepuis = (
  envoi: { instant: string; numero: string; predicatCanal: string },
  extra: string,
  gardes: string[],
): string => `${envoi.instant} is not null and exists (
           select 1 from conversations cv
             join conversation_messages m on m.conversation_id = cv.id
           where cv.tenant_id = c.tenant_id and not cv.is_test
             and cv.wa_id = regexp_replace(${envoi.numero}, '[^0-9]', '', 'g')
             and m.direction = 'in'
             and (${envoi.predicatCanal})
             and m.created_at > ${envoi.instant} ${extra}
             and ${gardes.join('\n             and ')}
         )`;

/**
 * Le canal, vu du funnel global : celui que la campagne déclare, ou n'importe lequel de ceux par lesquels elle a
 * réellement écrit à ce destinataire (sinon le funnel par canal et le funnel global se contrediraient dès
 * qu'une chaîne existe). Élargir, jamais remplacer : sans chaîne, le second terme n'ajoute rien, et aucun
 * `replied` existant ne bouge.
 *
 * Ordre des clauses : `campaign_id` puis `canal`, les colonnes de `campaign_envois_campagne_idx` ;
 * `recipient_id` n'a pas d'index.
 */
const CANAL_DECLARE_OU_TENTE = `m.channel = c.channel or exists (
               select 1 from campaign_envois e4
               where e4.campaign_id = c.id
                 and e4.canal = m.channel
                 and e4.recipient_id = r.id
                 and e4.statut = 'sent'
             )`;

/**
 * L'attribution ancrée sur le destinataire (`r`), celle du funnel global. Une seule garde d'intercalation, sans
 * exclusion (l'ancrage est la colonne comparée). Ne pas y ajouter de garde : elle déplacerait les chiffres de
 * toutes les campagnes.
 */
export const entrantAttribue = (extra = ''): string =>
  entrantAttribueDepuis({ instant: 'r.sent_at', numero: 'r.to_e164', predicatCanal: CANAL_DECLARE_OU_TENTE }, extra, [
    aucunDepartDestinataire('r.sent_at', 'r.to_e164'),
  ]);

/**
 * L'attribution ancrée sur une tentative du journal (`e`, `campaign_envois`) : même doctrine, à l'ancrage près
 * (l'instant et le canal de la tentative), sinon deux vérités sur l'écran de ventilation par canal.
 *
 * Deux gardes, qui disent la même règle sur deux populations : les départs d'un autre destinataire se lisent
 * sur `campaign_recipients` (en excluant la ligne du destinataire, sinon elle refuserait toute attribution), les
 * départs supplémentaires du même destinataire seulement dans le journal. `e.sent_at is not null` est toujours
 * vrai : un prédicat constant, prix du fragment partagé.
 */
export const entrantAttribueTentative = (extra = ''): string =>
  entrantAttribueDepuis({ instant: 'e.sent_at', numero: 'r.to_e164', predicatCanal: 'm.channel = e.canal' }, extra, [
    aucunDepartDestinataire('e.sent_at', 'r.to_e164', 'r.id'),
    aucunDepartJournalise('e.sent_at', 'r.to_e164'),
  ]);

export class PgStatsStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Séries « un point par jour » pour le dashboard, en jours Europe/Paris. Bornes SQL par la CTE `bounds`
   * (changement d'heure compris), borne haute exclusive = minuit Paris de (to+1). Paramètres : tenantId, from,
   * to, TZ.
   */
  async getDashboard(tenantId: string, range: DateRange): Promise<DashboardStats> {
    const { from, to } = range;

    // 1) Contacts cumulés par jour (baseline + somme courante, série dense). Les actifs par différence,
    //    cumulés(J) - supprimés(J) (la suppression est douce), plutôt qu'une sous-requête par jour ; la borne
    //    haute de `supprimes_dans` empêche une suppression d'aujourd'hui de réécrire le passé.
    const contacts = await this.pool.query<{ d: string; count: string; actifs: string }>(
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
       ),
       supprimes_avant as (
         select count(*)::int as n from contacts
         where tenant_id = $1 and deleted_at is not null and deleted_at < (select start_ts from bounds)
       ),
       supprimes_dans as (
         select date_trunc('day', deleted_at at time zone $4)::date as day, count(*)::int as n
         from contacts, bounds b
         where tenant_id = $1 and deleted_at is not null
           and deleted_at >= b.start_ts and deleted_at < b.end_ts
         group by 1
       )
       select to_char(s.day, 'YYYY-MM-DD') as d,
              ((select n from baseline) + coalesce(sum(dl.n) over (order by s.day), 0))::int as count,
              ((select n from baseline) + coalesce(sum(dl.n) over (order by s.day), 0)
               - (select n from supprimes_avant) - coalesce(sum(sp.n) over (order by s.day), 0))::int as actifs
       from series s
       left join daily dl on dl.day = s.day
       left join supprimes_dans sp on sp.day = s.day
       order by s.day`,
      [tenantId, from, to, TZ],
    );

    // 2) Templates envoyés par jour et par catégorie : campagnes (campaign_recipients + campaigns.category) et
    //    envois template depuis l'inbox (conversation_messages.template_category). `c.channel = 'whatsapp'` :
    //    une campagne RCS n'envoie aucun template.
    const templates = await this.pool.query<{ d: string; category: string | null; count: string }>(
      `with ${BOUNDS_CTE}
       select d, category, sum(cnt)::int as count from (
         select to_char(date_trunc('day', r.sent_at at time zone $4), 'YYYY-MM-DD') d, c.category, count(*) cnt
         from campaign_recipients r join campaigns c on c.id = r.campaign_id, bounds b
         where c.tenant_id = $1 and r.status = 'sent' and r.sent_at >= b.start_ts and r.sent_at < b.end_ts
           and c.channel = 'whatsapp'
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

    // 3) Messages hors template par jour, en une requête pour deux lectures : les échangés (entrants et
    //    sortants, tous canaux) et les seuls sortants WhatsApp, qui sont les messages de service. Le RCS en est
    //    exclu : cette série n'a pas de prix RCS et le montrerait comme gratuit.
    const exchanged = await this.pool.query<{ d: string; count: string; sortants: string }>(
      `with ${BOUNDS_CTE}
       select to_char(date_trunc('day', m.created_at at time zone $4), 'YYYY-MM-DD') as d,
              count(*)::int as count,
              count(*) filter (where m.direction = 'out' and m.channel = 'whatsapp')::int as sortants
       from conversation_messages m join conversations cv on cv.id = m.conversation_id, bounds b
       where cv.tenant_id = $1 and not cv.is_test and m.created_at >= b.start_ts and m.created_at < b.end_ts
         and (m.direction = 'in' or (m.direction = 'out' and m.type is distinct from 'template'))
       group by d order by d`,
      [tenantId, from, to, TZ],
    );

    // 4) Ventilation des messages de service par origine, avec exactement le filtre de `sortants` ci-dessus,
    //    pour que le total de la ventilation retombe sur celui de la courbe.
    const parOrigine = await this.pool.query<{ origine: string; n: string }>(
      `with ${BOUNDS_CTE}
       select ${ORIGINE_EFFECTIVE_SQL} as origine, count(*)::int as n
       from conversation_messages m join conversations cv on cv.id = m.conversation_id, bounds b
       where cv.tenant_id = $1 and not cv.is_test and m.created_at >= b.start_ts and m.created_at < b.end_ts
         and m.direction = 'out' and m.channel = 'whatsapp' and m.type is distinct from 'template'
       group by 1`,
      [tenantId, from, to, TZ],
    );
    const serviceParOrigine = { ia: 0, scenario: 0, humain: 0, indeterminee: 0 };
    const serviceIaDetail = { agent: 0, mba: 0, mcp: 0 };
    for (const ligne of parOrigine.rows) {
      // Une valeur d'origine inconnue de la table de correspondance tombe en « indéterminée » plutôt que
      // d'être perdue : c'est le seul comportement qui garde le total juste.
      const theme = THEME_DE_ORIGINE[ligne.origine] ?? 'indeterminee';
      serviceParOrigine[theme] += Number(ligne.n);
      // Le détail sort de la même boucle que le total, sur la même ligne, pour qu'ils ne dérivent pas.
      const detail = DETAIL_IA[ligne.origine];
      if (detail) serviceIaDetail[detail] += Number(ligne.n);
    }

    const utility: DailyPoint[] = [];
    const marketing: DailyPoint[] = [];
    for (const r of templates.rows) {
      const point = { date: r.d, count: Number(r.count) };
      if (r.category === 'marketing') marketing.push(point);
      else if (r.category === 'utility') utility.push(point);
    }

    return {
      contacts: contacts.rows.map((r) => ({ date: r.d, count: Number(r.count) })),
      contactsActifs: contacts.rows.map((r) => ({ date: r.d, count: Number(r.actifs) })),
      templates: { utility, marketing },
      exchanged: exchanged.rows.map((r) => ({ date: r.d, count: Number(r.count) })),
      service: exchanged.rows.map((r) => ({ date: r.d, count: Number(r.sortants) })),
      serviceParOrigine,
      serviceIaDetail,
    };
  }

  /**
   * Les messages écrits par l'agent de Meta, depuis toujours : ni les réponses du client, ni l'équipe, ni les
   * campagnes. `ORIGINE_EFFECTIVE_SQL` s'importe (alias `m`) : il couvre `origin = 'mba'` et la dérivation
   * `m.type = 'mba'` de l'historique, qu'un test écrit à la main raterait.
   *
   * 🔴 `c.tenant_id = $1` est le seul contrôle d'isolation : `conversation_messages` hérite l'espace de son fil,
   * et la RLS est contournée. `m.direction = 'out'` ne change aucun résultat mais tient le contrat de l'index
   * partiel `conversation_messages_origin_idx` (`where direction = 'out'`).
   */
  async messagesEcritsParMba(tenantId: string, depuis?: Date): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `select count(*)::text as n
         from conversation_messages m
         join conversations c on c.id = m.conversation_id
        where c.tenant_id = $1
          and not c.is_test
          and m.direction = 'out'
          and ${ORIGINE_EFFECTIVE_SQL} = 'mba'
          -- La fenêtre facultative du tableau de l'agent (Performance lab) ; absente = depuis toujours.
          and ($2::timestamptz is null or m.created_at >= $2::timestamptz)`,
      [tenantId, depuis ?? null],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Les messages envoyés et reçus par canal sur une fenêtre glissante de N jours (cartes « Numéro WhatsApp » et
   * « Canal RCS » de l'Accueil) : chaque ligne du fil de l'Inbox, rangée par `channel`, `out` envoyés, `in`
   * reçus. Tout ce qui part passe par ce fil, envois de campagne compris.
   *
   * Les modèles sont comptés, contrairement à « Messages échangés » : cette carte dit ce qui est passé par le
   * numéro. Écartés : les fils de test, et les canaux autres que `whatsapp` et `rcs`. Un envoi dont la
   * livraison a échoué reste compté (il est parti).
   *
   * 🔴 `cv.tenant_id = $1` est le seul contrôle d'isolation (la RLS est contournée).
   *
   * Index : `conversations_tenant_recent_idx` pour les fils actifs, puis `conversation_messages_conv_idx`. La
   * borne sur `cv.last_message_at` est un préfiltre, exact parce que les trois chemins d'écriture d'un message
   * avancent `last_message_at` juste avant leur `insert` (marge d'une heure) ; un nouveau chemin d'écriture doit
   * l'avancer lui aussi, sinon ses messages disparaîtraient de ce compte.
   */
  async volumesParCanal(tenantId: string, jours: number): Promise<VolumesParCanal> {
    const { rows } = await this.pool.query<{ canal: string; envoyes: string; recus: string }>(
      `select m.channel as canal,
              count(*) filter (where m.direction = 'out')::text as envoyes,
              count(*) filter (where m.direction = 'in')::text as recus
         from conversation_messages m
         join conversations cv on cv.id = m.conversation_id
        where cv.tenant_id = $1
          and not cv.is_test
          and cv.last_message_at > now() - make_interval(days => $2) - interval '1 hour'
          and m.created_at > now() - make_interval(days => $2)
        group by m.channel`,
      [tenantId, jours],
    );
    const volumes: VolumesParCanal = { whatsapp: { envoyes: 0, recus: 0 }, rcs: { envoyes: 0, recus: 0 } };
    for (const r of rows) {
      if (r.canal === 'whatsapp' || r.canal === 'rcs') volumes[r.canal] = { envoyes: Number(r.envoyes), recus: Number(r.recus) };
    }
    return volumes;
  }

  /**
   * Volume par template envoyé sur la période (campagnes et envois inbox), pour le dropdown du dashboard et le
   * prix estimé. Exclut les livraisons en échec. Une campagne RCS stocke `template_name = ''` et non null, d'où
   * `nullif` et `c.channel = 'whatsapp'` dans le fragment.
   */
  async getTemplateBreakdown(tenantId: string, range: DateRange): Promise<TemplateBreakdownRow[]> {
    const { from, to } = range;
    const res = await this.pool.query<{ name: string; category: string | null; count: string }>(
      `with ${BOUNDS_CTE}
       select name, category, count(*)::int as count
       from (${envoisTemplateFacturables(SANS_ATTRIBUTION)}) envois
       group by name, category order by count desc`,
      [tenantId, from, to, TZ],
    );
    return res.rows.map((r) => ({ name: r.name, category: r.category, count: Number(r.count) }));
  }

  /**
   * Funnel d'une campagne (scopée au tenant) : envoyés -> délivrés -> lus -> répondus, et échecs. « Répondu » =
   * un message entrant attribué à cet envoi (`entrantAttribue`). « Répondu » peut dépasser « lu » : le contact a
   * pu couper ses accusés de lecture, ou l'envoi n'a aucun accusé (`sansAccuse`, toute campagne à scénario).
   */
  async getCampaignFunnel(tenantId: string, campaignId: string): Promise<CampaignFunnel> {
    const res = await this.pool.query<{ sent: string; delivered: string; read: string; replied: string; failed: string; sans_accuse: string; button_replies: string; contacts_vises: string }>(
      `select
         -- Le grain CONTACT, et il est a part : une ligne par personne visee, que la chaine d etages ait
         -- fait une tentative ou trois pour la joindre. C est la contrainte unique (campaign_id,
         -- contact_id) qui le garantit, pas une convention.
         count(r.id)::int as contacts_vises,
         count(r.id) filter (where r.status = 'sent' and r.delivery_status is distinct from 'failed')::int as sent,
         count(r.id) filter (where r.delivery_status in ('delivered', 'read'))::int as delivered,
         count(r.id) filter (where r.delivery_status = 'read')::int as read,
         count(r.id) filter (where r.status = 'failed' or r.delivery_status = 'failed')::int as failed,
         -- Parti, mais aucun accusé de Meta : ni délivré, ni lu, ni échoué. « On ne sait pas », pas « non ».
         count(r.id) filter (where r.status = 'sent' and r.delivery_status is null)::int as sans_accuse,
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
      contactsVises: Number(row?.contacts_vises ?? 0),
      sent: Number(row?.sent ?? 0),
      delivered: Number(row?.delivered ?? 0),
      read: Number(row?.read ?? 0),
      replied: Number(row?.replied ?? 0),
      failed: Number(row?.failed ?? 0),
      sansAccuse: Number(row?.sans_accuse ?? 0),
      buttonReplies: Number(row?.button_replies ?? 0),
      urlClicks: (await this.clicsParCampagne(tenantId, [campaignId])).get(campaignId) ?? null,
      parCanal: await this.funnelParCanal(tenantId, campaignId),
    };
  }

  /**
   * La ventilation par canal d'une campagne, lue sur le journal des tentatives, en requête séparée : joindre les
   * personnes à leurs tentatives multiplierait les lignes et fausserait les compteurs du haut. La somme des
   * canaux n'est pas `sent` (une personne jointe au second étage compte deux tentatives).
   *
   * 🔴 Scopée au tenant par la jointure sur `campaigns` : `campaign_envois` ne porte pas de `tenant_id`. Tri par
   * `min(rang)` puis `canal` : l'ordre de la chaîne, stable d'un rafraîchissement à l'autre.
   */
  private async funnelParCanal(tenantId: string, campaignId: string): Promise<FunnelCanal[]> {
    const res = await this.pool.query<{
      canal: CanalEtage; envois: number; reussis: number; delivres: number; lus: number; repondus: number; sans_accuse: number;
    }>(
      `select e.canal,
         count(*)::int as envois,
         -- « Reussi » a EXACTEMENT la definition de « sent » du funnel global : parti, et pas dementi par
         -- un accuse d echec arrive apres coup. Une seconde definition rendrait deux chiffres sur un ecran.
         -- (Pas de guillemet oblique dans ces commentaires : il fermerait le gabarit JS. Invariant du depot.)
         count(*) filter (where e.statut = 'sent' and e.delivery_status is distinct from 'failed')::int as reussis,
         count(*) filter (where e.delivery_status in ('delivered', 'read'))::int as delivres,
         count(*) filter (where e.delivery_status = 'read')::int as lus,
         -- ⚠️ Le statut « sent » EN PLUS de l attribution : une tentative ECHOUEE n a rien envoye, donc ne
         -- peut rien avoir provoque. Sans cette garde, une reponse arrivee apres un echec WhatsApp serait
         -- portee au credit du canal qui vient precisement de ne pas fonctionner.
         count(*) filter (where e.statut = 'sent' and ${entrantAttribueTentative()})::int as repondus,
         -- Parti, mais aucun accusé de Meta : ni délivré, ni lu, ni échoué. « On ne sait pas », pas « non ».
         count(*) filter (where e.statut = 'sent' and e.delivery_status is null)::int as sans_accuse
       from campaign_envois e
         join campaigns c on c.id = e.campaign_id
         join campaign_recipients r on r.id = e.recipient_id
       where e.campaign_id = $1 and c.tenant_id = $2
       group by e.canal
       order by min(e.rang), e.canal`,
      [campaignId, tenantId],
    );
    return res.rows.map((l) => ({
      canal: l.canal,
      envois: Number(l.envois),
      reussis: Number(l.reussis),
      delivres: Number(l.delivres),
      lus: Number(l.lus),
      repondus: Number(l.repondus),
      sansAccuse: Number(l.sans_accuse),
    }));
  }

  /**
   * L'identité d'une campagne, scopée au tenant, pour la fiche de coût. 🔴 `getForRun` lit sans tenant : s'en
   * servir ici ferait de la route un IDOR sur la fiche de coûts d'un autre client. `null` = absente ou pas ici,
   * l'appelant en fait un 404.
   */
  async ficheCampagne(tenantId: string, campaignId: string): Promise<{ id: string; nom: string; template: string | null; workflowId: string | null } | null> {
    const res = await this.pool.query<{ id: string; name: string; template_name: string | null; workflow_id: string | null }>(
      `select id, name, nullif(template_name, '') as template_name, workflow_id
         from campaigns where id = $2 and tenant_id = $1`,
      [tenantId, campaignId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return { id: r.id, nom: r.name, template: r.template_name, workflowId: r.workflow_id };
  }

  /**
   * Les envois facturables d'une campagne sur toute sa vie, séparés en lancement et relances. Le lancement est
   * le premier envoi par personne (la base du coût par interaction) ; les templates renvoyés ensuite par le
   * scénario sont des relances, hors du ratio.
   *
   * Même population que `getVolumeParCampagne`, aux mêmes gardes (statut `sent`, livraison non `failed`, canal
   * WhatsApp, anti-double-compte par `meta_message_id`, attribution des envois de scénario, 72 h gratuites
   * exclues) : la fiche s'ouvre depuis le tableau et les deux coûts se lisent côte à côte. Aucune borne de
   * période (un scénario reçoit des réponses pendant des jours), sauf une borne basse au premier `claimed_at`
   * de la campagne, pour que la sous-requête corrélée ne balaie pas tout l'historique.
   */
  async envoisDeLaCampagne(tenantId: string, campaignId: string): Promise<EnvoisCampagneRow[]> {
    const res = await this.pool.query<{ category: string | null; total: string; lancement: string }>(
      `with debut as (
         -- ⚠️ SCOPEE elle aussi. La route ne peut pas l atteindre avec une campagne d un autre espace
         -- (ficheCampagne a deja rendu 404), mais la regle du depot est tenant_id = $1 sur CHAQUE requete
         -- PRECISEMENT parce qu une garde posee ailleurs disparait le jour ou la methode est reutilisee.
         -- La jointure ne coute rien, l oubli couterait un espace.
         -- (Pas de guillemet oblique dans ce commentaire : il fermerait le gabarit JS. Invariant du depot.)
         select min(coalesce(r.claimed_at, r.sent_at)) as le
           from campaign_recipients r
           join campaigns c on c.id = r.campaign_id and c.tenant_id = $1
          where r.campaign_id = $2 and r.sent_at is not null
       ),
       envois as (
         select r.sent_at as at, c.category as category,
                regexp_replace(r.to_e164, '[^0-9]', '', 'g') as wa
           from campaign_recipients r join campaigns c on c.id = r.campaign_id
          where c.id = $2 and c.tenant_id = $1 and nullif(c.template_name, '') is not null
            and c.channel = 'whatsapp' and r.status = 'sent'
            and (r.delivery_status is null or r.delivery_status <> 'failed')
            and ${horsEntreeGratuite('r.message_id', 'c.tenant_id')}
         union all
         select m.created_at as at, m.template_category as category, cv.wa_id as wa
           from conversation_messages m
           join conversations cv on cv.id = m.conversation_id, debut d
          where cv.tenant_id = $1 and not cv.is_test and m.direction = 'out' and m.type = 'template'
            and m.template_name is not null
            and d.le is not null and m.created_at >= d.le
            and not exists (
              select 1 from campaign_recipients r2 join campaigns c2 on c2.id = r2.campaign_id
              where c2.tenant_id = cv.tenant_id and r2.message_id = m.meta_message_id
            )
            and ${horsEntreeGratuite('m.meta_message_id', 'cv.tenant_id')}
            and $2::uuid = ${ATTRIBUTION_CAMPAGNE_SCENARIO}
       ),
       rangs as (select category, row_number() over (partition by wa order by at) as rang from envois)
       select category, count(*)::int as total, count(*) filter (where rang = 1)::int as lancement
         from rangs group by category`,
      [tenantId, campaignId],
    );
    return res.rows.map((r) => ({
      category: r.category, total: Number(r.total), lancement: Number(r.lancement),
    }));
  }

  /**
   * Les mesures du scénario d'une campagne, bloc par bloc, sur toute sa vie. `workflow_node_events` ne porte
   * pas la campagne : on réutilise exactement l'attribution des envois (la dernière campagne scénario réclamée
   * pour ce numéro avant l'événement), sinon deux vérités sur le même écran. Les événements anonymisés par la
   * rétention sortent du compte.
   *
   * Groupé par (bloc, nature) et non par handle : sinon `count(distinct wa_id)` compterait les personnes par
   * bouton, et l'appelant qui les additionne compterait deux fois qui tape deux boutons. Les clics sont
   * fusionnés à la lecture par `compteursDeClics`.
   */
  async mesuresScenarioParCampagne(tenantId: string, campaignId: string): Promise<NodeEventCount[]> {
    const res = await this.pool.query<{ node_id: string; kind: string; n: string; c: string }>(
      `select e.node_id, e.kind, count(*)::int as n, count(distinct e.wa_id)::int as c
         from workflow_node_events e
         join campaigns c on c.id = $2 and c.tenant_id = $1
        where e.tenant_id = $1 and c.workflow_id is not null and e.workflow_id = c.workflow_id
          and e.wa_id in (
            select regexp_replace(r.to_e164, '[^0-9]', '', 'g')
              from campaign_recipients r where r.campaign_id = c.id and r.sent_at is not null
          )
          and c.id = (
            select r3.campaign_id
              from campaign_recipients r3 join campaigns c3 on c3.id = r3.campaign_id
             where c3.tenant_id = $1 and c3.workflow_id is not null and r3.sent_at is not null
               and coalesce(r3.claimed_at, r3.sent_at) <= e.at
               and e.wa_id = regexp_replace(r3.to_e164, '[^0-9]', '', 'g')
             order by coalesce(r3.claimed_at, r3.sent_at) desc
             limit 1
          )
        group by e.node_id, e.kind
        order by e.node_id, e.kind`,
      [tenantId, campaignId],
    );
    return res.rows.map((r) => ({
      nodeId: r.node_id, kind: r.kind as NodeEventCount['kind'], handle: null,
      count: Number(r.n), contacts: Number(r.c),
    }));
  }

  /**
   * Clics sur les liens tracés des templates de plusieurs campagnes, depuis le premier envoi de chacune : une
   * seule définition pour le funnel (un identifiant) et le tableau de synthèse. Le seuil au premier envoi écarte
   * les clics de revue de Meta.
   *
   * Une campagne absente de la réponse n'a pas zéro clic, elle n'a rien de mesurable (scénario, ou template sans
   * lien tracé confirmé) : l'appelant en fait `null`. Le `where b.template_name is not null` double la jointure,
   * pour le jour où elle deviendrait externe.
   */
  async clicsParCampagne(tenantId: string, campaignIds: string[]): Promise<Map<string, number>> {
    if (campaignIds.length === 0) return new Map();
    const res = await this.pool.query<{ campaign_id: string; n: string | null }>(
      `with borne as (
         select c.id as campaign_id, c.template_name, c.template_language, min(r.sent_at) as premier_envoi
           from campaigns c join campaign_recipients r on r.campaign_id = c.id
          where c.tenant_id = $1 and c.id = any($2::uuid[]) and r.sent_at is not null
          group by c.id, c.template_name, c.template_language
       )
       select b.campaign_id, count(k.id)::int as n
         from borne b
         join tracked_links l
           on l.tenant_id = $1
          and l.template_name = b.template_name
          and l.template_language = b.template_language
          and l.confirmed_at is not null
         left join tracked_link_clicks k
           on k.code = l.code and k.tenant_id = $1 and k.at >= b.premier_envoi
        where b.template_name is not null
        -- GROUP BY indispensable : un count d agregat SANS group by rend TOUJOURS une ligne (a zero),
        -- donc 'aucun lien trace' serait devenu '0 clic', et l ecran afficherait une etape qui ment.
        -- Avec lui, zero ligne en entree = zero ligne en sortie = absence cote appelant.
        group by b.campaign_id`,
      [tenantId, campaignIds],
    );
    return new Map(res.rows.map((r) => [r.campaign_id, Number(r.n ?? 0)]));
  }

  /**
   * Les personnes qui se sont engagées sur une campagne : celles qui ont cliqué et celles qui ont répondu (une
   * réponse est un engagement de premier niveau). Des personnes, pas des gestes : `count(distinct ...)` sur
   * l'union, quelqu'un qui clique puis répond compte une fois.
   *
   * Sept jours après son propre envoi, par destinataire (`FENETRE_IMPUTATION`) : sans borne haute le chiffre ne
   * se stabiliserait jamais, bornée au premier envoi de la campagne une campagne étalée perdrait ses derniers
   * destinataires. Les clics anonymes (sans jeton) en sont absents. Campagne absente de la map = aucune mesure.
   *
   * Ses jointures sont des contrats avec des index existants, dont deux partiels :
   * `conversation_messages_unread_idx` (`WHERE direction = 'in'`), `tracked_link_clicks_contact_idx` et
   * `conversations_contact_idx` (`WHERE contact_id IS NOT NULL`). Compter des sortants ou des clics sans
   * `contact_id` sortirait de ces index sans erreur : si le besoin change, l'index change avec la requête.
   */
  async engagementsParCampagne(tenantId: string, campaignIds: string[]): Promise<Map<string, number>> {
    if (campaignIds.length === 0) return new Map();
    const res = await this.pool.query<{ campaign_id: string; n: string | null }>(
      `with envoyes as (
         select r.campaign_id, r.contact_id, r.sent_at
           from campaign_recipients r
           join campaigns c on c.id = r.campaign_id and c.tenant_id = $1
          where r.campaign_id = any($2::uuid[]) and r.sent_at is not null and r.contact_id is not null
       ),
       cliqueurs as (
         select distinct e.campaign_id, k.contact_id
           from envoyes e
           join tracked_link_clicks k
             on k.tenant_id = $1 and k.contact_id = e.contact_id
            and k.at >= e.sent_at and k.at < e.sent_at + ${FENETRE_IMPUTATION}
       ),
       repondeurs as (
         select distinct e.campaign_id, e.contact_id
           from envoyes e
           join conversations cv on cv.tenant_id = $1 and cv.contact_id = e.contact_id
           join conversation_messages m
             on m.conversation_id = cv.id and m.direction = 'in'
            and m.created_at >= e.sent_at and m.created_at < e.sent_at + ${FENETRE_IMPUTATION}
       ),
       engages as (
         select campaign_id, contact_id from cliqueurs
         union
         select campaign_id, contact_id from repondeurs
       )
       select e.campaign_id, count(*)::int as n
         from engages e
        group by e.campaign_id`,
      [tenantId, campaignIds],
    );
    return new Map(res.rows.map((r) => [r.campaign_id, Number(r.n ?? 0)]));
  }

  /**
   * Les messages de service imputés à chaque campagne : le coût par engagement inclut le service, pas seulement
   * les templates. Même fenêtre que `engagementsParCampagne` (`FENETRE_IMPUTATION`).
   *
   * 🔴 Un message n'est imputé qu'à une seule campagne, la dernière reçue avant lui : deux fenêtres qui se
   * chevauchent factureraient sinon le message deux fois (un engagé, lui, peut créditer deux campagnes : une
   * personne n'est pas une dépense). Le filtre de service est celui de `serviceParMois` (sortant, WhatsApp, hors
   * template, hors fil de test, 72 h gratuites exclues), qui doit rester d'accord avec ses autres lecteurs.
   */
  async servicesParCampagne(tenantId: string, campaignIds: string[], range: DateRange): Promise<Map<string, number>> {
    if (campaignIds.length === 0) return new Map();
    const { from, to } = range;
    const res = await this.pool.query<{ campaign_id: string; n: string | null }>(
      `with ${BOUNDS_CTE},
       envoyes as (
         select r.campaign_id, r.contact_id, r.sent_at
           from campaign_recipients r
           join campaigns c on c.id = r.campaign_id and c.tenant_id = $1
          where r.campaign_id = any($5::uuid[]) and r.sent_at is not null and r.contact_id is not null
       ),
       services as (
         -- 🔴 BORNEE PAR LA PERIODE, ET SON ABSENCE RENDAIT LE CHIFFRE FAUX D UN FACTEUR DIX. Le prix
         -- unitaire applique a ces messages vient de serviceParMois, qui est bornee ; le cout template de
         -- la meme campagne l est aussi. Sans borne ici, une campagne etalee sur deux jours se voyait
         -- imputer TOUS ses messages de service depuis toujours, au prix effectif d une seule journee : la
         -- somme des campagnes depassait le total de la ligne « Messages » de la meme carte. Un chiffre qui
         -- n etait ni « ce que cette campagne a coute sur la periode » ni « ce qu elle a coute en tout »,
         -- donc plausible et faux, le mode de panne que tout ce lot se donne pour mission d eviter.
         -- Releve en revue finale le 2026-09-18.
         --
         -- ⚠️ engagementsParCampagne n a PAS de borne de periode, et cette phrase a d abord dit que « son
         -- resultat n est divise par aucun total de periode ». C ETAIT FAUX : il EST le denominateur du
         -- cout par engagement, dont le numerateur est desormais entierement borne. Pour une campagne dont
         -- les envois debordent de la fenetre affichee, on divise donc un cout de periode par des engages
         -- de toute la vie de la campagne, et le cout par engage sort trop bas. Le critere du cadrage (la
         -- MEME fenetre de sept jours des deux cotes) reste tenu, d ou le jaune plutot que le rouge, mais
         -- la borner reste a faire et c est ecrit dans todo.md. Releve a la troisieme revue du 2026-09-18.
         select cv.contact_id, m.created_at, m.id as message_id
           from conversation_messages m
           join conversations cv on cv.id = m.conversation_id
           cross join bounds b
          where cv.tenant_id = $1 and not cv.is_test and cv.contact_id is not null
            and m.created_at >= b.start_ts and m.created_at < b.end_ts
            and m.direction = 'out' and m.channel = 'whatsapp' and m.type is distinct from 'template'
            and ${horsEntreeGratuite('m.meta_message_id', 'cv.tenant_id')}
       ),
       impute as (
         -- LA DERNIERE campagne recue avant ce message, et elle seule. Le tri descendant sur sent_at fait
         -- le choix ; la fenetre de sept jours le borne.
         -- ⚠️ LA CLE EST L IDENTIFIANT DU MESSAGE, pas (contact, instant) : deux messages au meme
         -- horodatage pour le meme contact n en comptaient qu UN, donc la propriete annoncee etait en
         -- realite « un INSTANT n est impute qu a une seule campagne ». Peu probable en microsecondes, mais
         -- lever le doute ne coute rien.
         select distinct on (s.message_id) e.campaign_id
           from services s
           join envoyes e
             on e.contact_id = s.contact_id
            and s.created_at >= e.sent_at and s.created_at < e.sent_at + ${FENETRE_IMPUTATION}
          order by s.message_id, e.sent_at desc
       )
       select campaign_id, count(*)::int as n from impute group by campaign_id`,
      // L'ordre est celui de `BOUNDS_CTE`, qui réserve $2, $3 et $4 : la liste de campagnes prend $5.
      [tenantId, from, to, TZ, campaignIds],
    );
    return new Map(res.rows.map((r) => [r.campaign_id, Number(r.n ?? 0)]));
  }

  /**
   * Le volume d'envois facturables de la période, par campagne et par catégorie : les mêmes volumes que le
   * graphe de coût (`envoisTemplateFacturables`, attribution comprise). La population est plus large : les
   * campagnes qui ont touché quelqu'un sans rien de facturable ont une ligne à volume nul. Le coût se calcule
   * dans `estimateCoutParCampagne`. Les envois hors campagne sont écartés (pas de ligne « le reste »), d'où un
   * graphe de coût qui peut totaliser davantage.
   */
  async getVolumeParCampagne(
    tenantId: string,
    range: DateRange,
    /**
     * Les campagnes archivées entrent-elles dans le tableau ? Non par défaut. Le filtre s'applique avant le
     * plafond : après, une archivée prendrait la place d'une campagne visible puis disparaîtrait de l'écran.
     */
    opts: {
      inclureArchivees?: boolean;
      /**
       * La rétention d'instance, en jours (`CONVERSATION_RETENTION_DAYS`), pour savoir si les envois d'une
       * campagne ont pu être purgés. Absente = rien n'est marqué hors rétention : un appelant qui l'ignore ne
       * doit pas faire disparaître des coûts.
       */
      retentionJours?: number;
    } = {},
  ): Promise<VolumeCampagneRow[]> {
    const { from, to } = range;
    const res = await this.pool.query<{
      campaign_id: string; nom: string; template: string | null; canal: string; category: string | null; count: string; envois: string;
      hors_retention: boolean;
    }>(
      `with ${BOUNDS_CTE},
       v as (
         select envois.campaign_id as campaign_id, envois.category as category, count(*)::int as n
         from (${envoisTemplateFacturables(ATTRIBUTION_CAMPAGNE_SCENARIO)}) envois
         where envois.campaign_id is not null
         group by 1, 2
       ),
       -- 🔴 LES CAMPAGNES QUI ONT TOUCHÉ QUELQU'UN, FACTURABLE OU NON (lot 4). Seules celles qui avaient un envoi de
       -- MODÈLE facturable apparaissaient : une campagne à scénario (texte dans la fenêtre de service), RCS, ou
       -- envoyée à un numéro de test, disparaissait du tableau. Mesuré : 2 campagnes visibles sur 7.
       -- ⚠️ ELLE REPARCOURT campaign_recipients, QUE LA BRANCHE 1 DES FACTURABLES PARCOURT DÉJÀ, et aucun index
       -- ne sert sent_at : deux parcours au lieu d'un, assumés sur un écran d'administration qu'on ouvre pour se
       -- faire une idée (relevé en revue le 2026-09-23). À dériver du même passage le jour où la table grossit.
       e as (
         select r.campaign_id as campaign_id, count(*)::int as n, max(r.sent_at) as dernier
         from campaign_recipients r join campaigns c on c.id = r.campaign_id, bounds b
         where c.tenant_id = $1 and r.status = 'sent'
           and r.sent_at >= b.start_ts and r.sent_at < b.end_ts
           and (r.delivery_status is null or r.delivery_status <> 'failed')
         group by 1
       ),
       -- Les deux comptes CÔTE À CÔTE : le facturable (qui chiffre) et le touché (que la colonne montre).
       p as (
         select coalesce(f.campaign_id, e.campaign_id) as campaign_id,
                coalesce(f.facturables, 0) as facturables, coalesce(e.n, 0) as touches
         from (select campaign_id, sum(n)::int as facturables from v group by campaign_id) f
         full outer join e on e.campaign_id = f.campaign_id
       ),
       -- Les campagnes qui ont le PLUS envoye, plafonnees. Une de plus que le plafond : c'est ainsi que
       -- l'appelant sait qu'il tronque, et le dit. Le tri final se fait au COUT, que le SQL ne connait pas
       -- encore (il ne voit pas les tarifs Meta) : la ligne ecartee est donc la moins envoyee.
       -- 🔴 LA COUPE SE FAIT SUR CE QUE LA COLONNE MONTRE (revue finale du 2026-09-23), c'est-à-dire le plus grand
       -- des deux comptes, et estimateCoutParCampagne rejoue EXACTEMENT ce critère. Trier sur le seul
       -- facturable mettait toutes les campagnes à scénario à égalité (0), départagées par leur identifiant.
       garde as (
         select p.campaign_id from p join campaigns c on c.id = p.campaign_id and c.tenant_id = $1
         where ($6::boolean or c.archived_at is null)
         order by greatest(p.facturables, p.touches) desc, p.campaign_id asc limit $5
       )
       select g.campaign_id as campaign_id, c.name as nom, c.template_name as template, c.channel as canal,
              v.category as category, coalesce(v.n, 0) as count, coalesce(e.n, 0) as envois,
              -- 🔴 LES ENVOIS DE CETTE CAMPAGNE ONT-ILS PU ETRE PURGES ? Un envoi de SCENARIO ne vit pas dans
              -- campaign_recipients mais dans les conversations, et la purge les supprime (leurs messages
              -- partent en cascade). Passe cette borne, « rien de facturable » ne veut plus dire « rien n a
              -- ete facture » mais « on ne peut plus le savoir », et afficher 0 se lirait « gratuit ».
              -- ⚠️ LA DUREE EST CELLE DE LA PURGE, le MEME texte (dureeConservationSql, src/inbox/retention.ts,
              -- lot 6) : le zero d instance arrete tout, le zero d espace n arrete que cet espace hors de la Base, et
              -- la borne se compte en jours. Deux definitions de « purge » divergeraient au premier reglage change.
              -- ⚠️ ON SE CALE SUR LE DERNIER ENVOI de la campagne, pas sur sa creation : c est lui qui date
              -- les conversations qu elle a ouvertes.
              (d.jours > 0
                 and $7::int > 0
                 and coalesce(e.dernier, (select max(r2.sent_at) from campaign_recipients r2 where r2.campaign_id = g.campaign_id))
                     < now() - make_interval(days => d.jours)) as hors_retention
       from garde g
       join campaigns c on c.id = g.campaign_id and c.tenant_id = $1
       left join lateral (
         select ${dureeConservationSql({ instance: '$7', grace: '$8', base: '$9' })} as jours
           from tenants t
           left join tenant_settings ts on ts.tenant_id = t.id
          where t.id = $1
       ) d on true
       left join v on v.campaign_id = g.campaign_id
       left join e on e.campaign_id = g.campaign_id`,
      [tenantId, from, to, TZ, PLAFOND_CAMPAGNES_SYNTHESE + 1, opts.inclureArchivees === true,
       Math.max(0, Math.floor(opts.retentionJours ?? 0)), GRACE_RETOUR_BASE_JOURS, DROITS.base.limites.conservationJours],
    );
    return res.rows.map((r) => ({
      campaignId: r.campaign_id, nom: r.nom, template: r.template, canal: r.canal,
      category: r.category, count: Number(r.count), envois: Number(r.envois),
      horsRetention: r.hors_retention === true,
    }));
  }

  /**
   * Répartition des codes d'erreur Meta sur la plage (campagnes du tenant), par occurrences décroissantes.
   * Population et ancrage viennent de `echecs-sql.ts`, comme le journal d'exploitation : un clic sur « 12 »
   * ouvre exactement 12 lignes dans `PgErreursLivraisonStore.lister`. Un échec sans code Meta (template
   * inenvoyable, panne réseau) n'y figure pas : il vit dans le journal des erreurs, et l'écran doit le dire.
   */
  async getErrorBreakdown(tenantId: string, range: DateRange, templateName?: string): Promise<ErrorBreakdownRow[]> {
    const { from, to } = range;
    const res = await this.pool.query<{
      code: number; template_name: string | null; campaign_id: string; campaign_name: string; count: string;
    }>(
      `with ${BOUNDS_CTE}
       select r.error_code as code, c.template_name as template_name,
              c.id as campaign_id, c.name as campaign_name, count(*)::int as count
       from campaign_recipients r join campaigns c on c.id = r.campaign_id, bounds b
       where c.tenant_id = $1 and r.error_code is not null and (${RECIPIENT_FAILED_SQL})
         and ${INSTANT_ECHEC_SQL} >= b.start_ts
         and ${INSTANT_ECHEC_SQL} < b.end_ts
         and ($5::text is null or c.template_name = $5::text)
       group by r.error_code, c.template_name, c.id, c.name
       order by count desc, code asc`,
      [tenantId, from, to, TZ, templateName ?? null],
    );
    return res.rows.map((r) => ({
      code: Number(r.code), count: Number(r.count), templateName: r.template_name,
      campaignId: r.campaign_id, campaignName: r.campaign_name,
    }));
  }

  /**
   * Volume d'envois de template facturables par (jour Paris, catégorie) sur la plage, filtrable par campagne
   * ou par template : la base du graphe de coût estimé. La population et ses gardes vivent dans
   * `envoisTemplateFacturables`, dont `c.channel = 'whatsapp'` (un RCS n'est pas au tarif Meta). Les deux
   * branches ne s'ancrent pas sur la même colonne (`sent_at` / `created_at`), et `category` peut être `null`.
   */
  async getCostVolume(tenantId: string, range: DateRange, filter: FiltreCampagneOuTemplate): Promise<CostVolumeRow[]> {
    const { from, to } = range;
    const res = await this.pool.query<{ date: string; category: string | null; count: string }>(
      `with ${BOUNDS_CTE}
       select to_char(envois.sent_at at time zone $4, 'YYYY-MM-DD') as date, envois.category as category,
              count(*)::int as count
       from (${envoisTemplateFacturables(ATTRIBUTION_CAMPAGNE_SCENARIO)}) envois
       -- 🔴 Le filtre par CAMPAGNE exclut les envois hors campagne : leur campaign_id est null, donc
       --    \`= any(...)\` vaut NULL, donc pas TRUE, donc la ligne sort du where. Le filtre par TEMPLATE
       --    les inclut. Les deux sont voulus, et tenus par un test.
       where ($5::uuid[] is null or envois.campaign_id = any($5::uuid[]))
         and ($6::text[] is null or envois.name = any($6::text[]))
       group by 1, 2`,
      // Liste vide -> null, pas un tableau vide : `= any('{}')` ne matche rien et effacerait le graphe.
      [
        tenantId, from, to, TZ,
        filter.campaignIds?.length ? filter.campaignIds : null,
        filter.templateNames?.length ? filter.templateNames : null,
      ],
    );
    return res.rows.map((r) => ({ date: r.date, category: r.category, count: Number(r.count) }));
  }

  /**
   * La grille de prix, une seule pour tous les espaces, telle quelle (`grilleDepuisLigne` la lit). Pas de
   * paramètre d'espace : un paramètre accepté et ignoré ferait croire qu'on lit le prix d'un client.
   *
   * `select *` plutôt que des colonnes nommées : avant sa migration, nommer une colonne absente ferait échouer
   * en `42703` au lieu de retomber sur les défauts. Aucun cache : une ligne par clé primaire, et un cache par
   * process rendrait un prix changé dans `/ops` invisible de l'API ou du worker.
   */
  async grillePrixGlobale(): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.pool.query<Record<string, unknown>>('select * from grille_prix limit 1');
      return res.rows[0] ?? null;
    } catch {
      // Table absente (API déployée avant la migration) : la grille par défaut fait l'affaire, et elle rend
      // exactement les chiffres d'avant.
      return null;
    }
  }

  /**
   * Les messages de service, mois par mois, avec ce qui a été consommé avant la fenêtre affichée : c'est cette
   * forme qui rend la franchise mensuelle juste (la même période en début ou en fin de mois est gratuite ou
   * payante). Le balayage commence au 1er du mois de la borne basse, donc tout message antérieur à `start_ts`
   * appartient au mois de départ.
   *
   * 🔴 Le filtre est celui des messages de service de la courbe et de sa ventilation (sortant, WhatsApp, hors
   * template, hors fil de test), plus l'exclusion des 72 h gratuites que seules les lectures de coût portent.
   */
  async serviceParMois(tenantId: string, range: DateRange): Promise<{ mois: string; avantLaPeriode: number; dansLaPeriode: number }[]> {
    const { from, to } = range;
    const res = await this.pool.query<{ mois: string; avant: number; dans: number }>(
      `with ${BOUNDS_CTE},
       cadre as (
         select (date_trunc('month', b.start_ts at time zone $4)) at time zone $4 as depuis,
                b.start_ts as start_ts, b.end_ts as end_ts
           from bounds b
       )
       select to_char(date_trunc('month', m.created_at at time zone $4), 'YYYY-MM') as mois,
              count(*) filter (where m.created_at < c.start_ts)::int as avant,
              count(*) filter (where m.created_at >= c.start_ts)::int as dans
         from conversation_messages m
         join conversations cv on cv.id = m.conversation_id
         cross join cadre c
        where cv.tenant_id = $1 and not cv.is_test
          and m.created_at >= c.depuis and m.created_at < c.end_ts
          and m.direction = 'out' and m.channel = 'whatsapp' and m.type is distinct from 'template'
          and ${horsEntreeGratuite('m.meta_message_id', 'cv.tenant_id')}
        group by 1
        order by 1`,
      [tenantId, from, to, TZ],
    );
    return res.rows.map((r) => ({ mois: r.mois, avantLaPeriode: Number(r.avant), dansLaPeriode: Number(r.dans) }));
  }

  /**
   * Les envois RCS de la période et les réactions qui peuvent les faire basculer au tarif conversationnel.
   *
   * Une ligne par (conversation, campagne), avec tous les instants en `array_agg` : la règle vit dans
   * `basculesRcs`, pure, et la recopier en SQL ferait deux implémentations ; ce transport reste compact sans
   * rien approximer. Les envois sans campagne restent dans le lot (`campaignId` null) : la bascule porte sur
   * l'échange entier.
   *
   * 🔴 Les réactions vont jusqu'à `fenetreMs` après la fin de la période (un RCS du 30 peut basculer le 3), la
   * fenêtre venant de `FENETRE_BASCULE_MS` et non d'un `interval` réécrit. Une réaction est un entrant sur le
   * même canal : une réponse WhatsApp ne fait pas basculer un RCS.
   *
   * La campagne se trouve en trois coups : l'identifiant du message côté destinataire, puis côté étage
   * (`campaign_envois`), puis l'attribution des templates de scénario. Ce dernier coup est coûteux (sous-requête
   * corrélée sans index) : il ne tourne que sur demande, comme dans `envoisTemplateFacturables`.
   */
  async envoisEtReactionsRcs(
    tenantId: string,
    range: DateRange,
    fenetreMs: number,
    /**
     * Faut-il rattacher chaque envoi à sa campagne ? Défaut `false`, le moins cher : seul l'appelant qui lit
     * `campaignId` paie la sous-requête. Oublier de demander se voit (coûts par campagne vides), l'inverse non.
     */
    opts: { attribuer?: boolean } = {},
  ): Promise<{
    conversations: { conversationId: string; campaignId: string | null; waId: string; envois: number; instants: string[] }[];
    reactions: { waId: string; at: string }[];
  }> {
    const { from, to } = range;
    const secondes = Math.round(fenetreMs / 1000);
    const [envois, reactions] = await Promise.all([
      this.pool.query<{ conversation_id: string; campaign_id: string | null; wa_id: string; envois: number; instants: string[] }>(
        `with ${BOUNDS_CTE},
         envois as (
           select cv.id::text as conversation_id, cv.wa_id as wa_id, m.created_at as at,
                  case when $5::boolean then coalesce(
                    (select r.campaign_id from campaign_recipients r join campaigns c on c.id = r.campaign_id
                      where c.tenant_id = cv.tenant_id and r.message_id = m.meta_message_id limit 1),
                    (select e.campaign_id from campaign_envois e join campaigns c on c.id = e.campaign_id
                      where c.tenant_id = cv.tenant_id and e.message_id = m.meta_message_id limit 1),
                    ${ATTRIBUTION_CAMPAGNE_SCENARIO}
                  ) end::text as campaign_id
             from conversation_messages m
             join conversations cv on cv.id = m.conversation_id, bounds b
            where cv.tenant_id = $1 and not cv.is_test and m.channel = 'rcs' and m.direction = 'out'
              and m.created_at >= b.start_ts and m.created_at < b.end_ts
         )
         select conversation_id, campaign_id, wa_id, count(*)::int as envois,
                array_agg(to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') order by at) as instants
           from envois group by 1, 2, 3`,
        [tenantId, from, to, TZ, opts.attribuer === true],
      ),
      this.pool.query<{ wa_id: string; at: string }>(
        `with ${BOUNDS_CTE}
         select cv.wa_id as wa_id,
                to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
           from conversation_messages m
           join conversations cv on cv.id = m.conversation_id, bounds b
          where cv.tenant_id = $1 and not cv.is_test and m.channel = 'rcs' and m.direction = 'in'
            and m.created_at >= b.start_ts
            and m.created_at < b.end_ts + make_interval(secs => $5::int)`,
        [tenantId, from, to, TZ, secondes],
      ),
    ]);
    return {
      conversations: envois.rows.map((r) => ({
        conversationId: r.conversation_id,
        campaignId: r.campaign_id,
        waId: r.wa_id,
        envois: Number(r.envois),
        instants: Array.isArray(r.instants) ? r.instants : [],
      })),
      reactions: reactions.rows.map((r) => ({ waId: r.wa_id, at: r.at })),
    };
  }

  /**
   * Ce que les TOURS D'AGENT ont coûté au client sur la période, et leur détail : `agent_sessions` porte ce que
   * chaque tour a débité de son crédit, au prix client depuis le 2026-09-28. ⚠️ Ce n'est pas tout le crédit
   * consommé : les essais du bac à sable et les traductions débitent sans session, et n'apparaissent qu'au journal
   * des mouvements (`agent_credit_mouvements`). Ce que coûte notre propre clé n'a rien à faire ici, et le Meta
   * Business Agent est facturé par Meta au message de service. La liste est plafonnée et le dit.
   */
  async consommationIa(tenantId: string, range: DateRange, plafond: number): Promise<{
    coutMicroEur: number; tokensEntree: number; tokensSortie: number; sessions: number;
    tours: { id: string; agentId: string; tours: number; tokensEntree: number; tokensSortie: number; coutMicroEur: number; at: string }[];
    tronque: boolean;
  }> {
    const { from, to } = range;
    const [total, liste] = await Promise.all([
      this.pool.query<{ sessions: string; tin: string; tout: string; cout: string }>(
        `with ${BOUNDS_CTE}
         select count(*)::text as sessions,
                coalesce(sum(tokens_in), 0)::text as tin,
                coalesce(sum(tokens_out), 0)::text as tout,
                coalesce(sum(cout_micro_eur), 0)::text as cout
           from agent_sessions s, bounds b
          where s.tenant_id = $1 and s.created_at >= b.start_ts and s.created_at < b.end_ts`,
        [tenantId, from, to, TZ],
      ),
      this.pool.query<{ id: string; agent_id: string; tours: number; tin: string; tout: string; cout: string; at: string }>(
        `with ${BOUNDS_CTE}
         select s.id::text as id, s.agent_id::text as agent_id, s.tours as tours,
                s.tokens_in::text as tin, s.tokens_out::text as tout, s.cout_micro_eur::text as cout,
                to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
           from agent_sessions s, bounds b
          where s.tenant_id = $1 and s.created_at >= b.start_ts and s.created_at < b.end_ts
          order by s.created_at desc
          limit $5::int`,
        // Une de plus que le plafond : c'est ainsi qu'on sait qu'on tronque.
        [tenantId, from, to, TZ, plafond + 1],
      ),
    ]);
    const t = total.rows[0];
    const lignes = liste.rows.slice(0, plafond).map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      tours: Number(r.tours),
      tokensEntree: Number(r.tin),
      tokensSortie: Number(r.tout),
      coutMicroEur: Number(r.cout),
      at: r.at,
    }));
    return {
      coutMicroEur: Number(t?.cout ?? 0),
      tokensEntree: Number(t?.tin ?? 0),
      tokensSortie: Number(t?.tout ?? 0),
      sessions: Number(t?.sessions ?? 0),
      tours: lignes,
      tronque: liste.rows.length > plafond,
    };
  }
}
