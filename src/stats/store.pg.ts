import type { Pool } from 'pg';
import { STATS_TZ, BOUNDS_CTE } from './range';
import type { DateRange } from './range';
import { ORIGINE_EFFECTIVE_SQL, THEME_DE_ORIGINE } from '../inbox/origine';
import { RECIPIENT_FAILED_SQL, INSTANT_ECHEC_SQL } from '../campaign/echecs-sql';

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
  /**
   * La campagne d'où viennent ces erreurs. Elle n'est JAMAIS nulle : la seule population capable de porter
   * une erreur est `campaign_recipients`, jointe à sa campagne (voir le docblock de `getErrorBreakdown`).
   *
   * ⚠️ Ces deux champs rendent la ligne PLUS FINE qu'avant : une par (code, template, campagne) au lieu
   * d'une par (code, template). L'écran agrège déjà par code, donc l'affichage sans filtre est inchangé ;
   * ce qui change, c'est qu'il peut désormais filtrer par campagne sans redemander au serveur.
   */
  campaignId: string;
  campaignName: string;
}


/** Volume d'envois de campagne par (jour, catégorie) — base du graphe de coût estimé. */
export interface CostVolumeRow {
  date: string; // 'YYYY-MM-DD' (Europe/Paris)
  /**
   * 'marketing' | 'utility' | **null**. Le null est arrivé avec la branche « hors campagne » : un envoi de
   * scénario historique n'a pas de catégorie (`logTemplateSent` ne l'écrivait pas avant le 2026-09-07), et
   * `estimateCostSeries` l'ignore alors. Le type le DIT désormais, au lieu de laisser un null atterrir dans
   * un champ déclaré `string` : c'est précisément la valeur que l'écran doit rendre visible.
   */
  category: string | null;
  count: number;
}

/**
 * Le filtre commun des écrans d'Analytics : DES campagnes OU DES templates. Plusieurs valeurs -> un résultat
 * COMPILÉ sur l'ensemble (les volumes s'additionnent jour par jour), pas la première valeur de la liste.
 *
 * Les deux axes restent MUTUELLEMENT EXCLUSIFS côté écran : combiner « campagne A » et « template B » ne
 * décrirait pas une union mais leur intersection, qui ne veut rien dire pour un opérateur. Une liste vide
 * équivaut à « tout », comme l'absence de filtre.
 *
 * ⚠️ Les deux axes ne désignent pas exactement la même population selon l'écran : côté coût, l'axe template
 * ramène AUSSI les envois hors campagne, alors qu'aucune erreur ne peut exister hors campagne. Le filtre est
 * le même, ce qu'il filtre ne l'est pas.
 */
export interface FiltreCampagneOuTemplate {
  campaignIds?: string[];
  templateNames?: string[];
}
/**
 * Le filtre du graphe de coût. ALIAS et non copie : la liste des contacts touchés filtre sur les deux mêmes
 * axes, et deux interfaces jumelles auraient divergé au premier axe ajouté. Le nom historique reste, il est
 * importé par le câblage et par les routes.
 */
export type CostFilter = FiltreCampagneOuTemplate;

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
  /**
   * Les mêmes messages de service, ventilés par ce qui les a ÉCRITS (migration 0099).
   *
   * Trois thèmes demandés par Julien : l'IA (notre agent et celui de Meta), le scripté (un scénario), et
   * l'humain (un opérateur depuis l'inbox). Un quatrième, `indeterminee`, n'existe que pour rendre visible
   * un chemin d'écriture qui aurait oublié de poser son origine : il vaut zéro tant que tout est en règle,
   * et le montrer est le seul moyen de ne pas classer un tel message en silence dans un thème qui l'accueille.
   *
   * 🔴 Le total de cette ventilation ÉGALE la somme de `service` sur la période. C'est ce qui la rend
   * lisible à côté de la courbe : un écart voudrait dire qu'un message échappe au classement.
   */
  serviceParOrigine: { ia: number; scenario: number; humain: number; indeterminee: number };
}

/**
 * 🔴 LES ENVOIS DE TEMPLATE FACTURABLES DE LA PÉRIODE, EN UN SEUL ENDROIT.
 *
 * Ce fragment existe parce que deux requêtes décrivaient la même chose et comptaient deux populations
 * DIFFÉRENTES. `getTemplateBreakdown` portait l'union vers `conversation_messages`, `getCostVolume` non :
 * un template envoyé par un nœud de scénario (ou depuis l'inbox) était donc compté dans le tableau
 * « Détail par template » et INVISIBLE du graphe « Coût estimé ». Mesuré le 2026-09-07 en production sur
 * `actu_cin_ma_2` : 0 côté coût, 7 côté détail, et sept autres templates dans le même cas. Le client
 * filtrait sur un template réellement envoyé et obtenait un graphe vide.
 *
 * Même doctrine que `RECIPIENT_FAILED_SQL` (`src/campaign/echecs-sql.ts`) : un fragment SQL partagé, jamais
 * deux copies, parce que deux copies divergent à la première correction.
 *
 * Rend une ligne PAR ENVOI, avec de quoi agréger des deux façons dont on a besoin :
 *  - `sent_at` pour le découpage par jour (le coût), sans découpage pour le volume (le détail) ;
 *  - `campaign_id` : celui de la campagne pour un envoi de campagne, celui de la campagne SCÉNARIO qui a
 *    démarré le parcours pour un envoi de scénario (attribution à la lecture, voir la sous-requête), et
 *    `null` seulement si ce contact n'a JAMAIS été destinataire d'une campagne scénario.
 *    🔴 **Portée réelle, à connaître avant de lire le chiffre** : l'attribution remonte au dernier
 *    destinataire réclamé, SANS borne basse. Dès qu'un contact a reçu une campagne scénario, tous ses
 *    envois de scénario ultérieurs lui sont attribués, quel que soit ce qui les a déclenchés (mot-clé,
 *    webhook, lien de chaîne). C'est le compromis assumé de l'attribution à la lecture, choisie le
 *    2026-09-07 pour ne pas traverser le chemin qui reçoit les messages clients. Le seul moyen de faire
 *    mieux est d'écrire l'attribution à l'envoi.
 *    🔴 C'est ce `null` qui gouverne le filtre par campagne : `campaign_id = any($5)` vaut alors `NULL`, donc PAS `TRUE`, donc la ligne sort du `where`.
 *    ⚠️ Écrire « c'est faux » serait une justification fausse, et elle s'inverserait sous une négation
 *    (`not (...)`, `is distinct from`), où `NULL` ne se comporte pas comme `false`. Filtrer sur une
 *    campagne exclut donc les envois hors campagne, filtrer sur un template les inclut ; les deux sont
 *    voulus et tenus par un test.
 *
 * ⚠️ S'utilise UNIQUEMENT dans une requête qui déclare `${BOUNDS_CTE}` et passe `$1` = tenantId.
 *
 * 🔴 LES DEUX BRANCHES NE TRAITENT PAS L'ÉCHEC DE LA MÊME FAÇON, et le nier serait une justification
 * fausse. Un message jamais PARTI n'a de ligne dans aucune des deux. Mais un échec de LIVRAISON n'est
 * suivi que côté campagne (`delivery_status`), la branche 2 n'en a aucune notion : un template de scénario
 * refusé après coup y reste compté. C'est une asymétrie réelle du modèle, pas un oubli de ce fragment.
 */
/**
 * 🔴 L ATTRIBUTION EST OPTIONNELLE, ET CE N EST PAS UN CONFORT. Cette sous-requete est CORRELEE : elle
 * s execute une fois PAR LIGNE de la branche 2, et son predicat
 * `cv.wa_id = regexp_replace(r3.to_e164, ...)` n est servi par AUCUN index (la migration 0096 a
 * explicitement refuse un index sur `campaign_recipients(to_e164, sent_at)`). Or `getTemplateBreakdown`
 * groupe sur `name, category` : il paierait ce balayage pour une colonne qu il JETTE, a chaque affichage
 * du tableau de bord. Le fragment reste UNIQUE, seule l attribution se branche.
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
    )`;

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
 * `RECIPIENT_FAILED_SQL` (`src/campaign/echecs-sql.ts`).
 *
 * ⚠️ S'utilise UNIQUEMENT dans une requête où `c` est `campaigns` et `r` est `campaign_recipients`.
 * `extra` restreint la nature du message entrant (ex. `and m.type = 'button'`).
 *
 * 🔴 `m.channel = c.channel` : l'entrant doit venir du MÊME tuyau que la campagne. Sans ça, un contact qui
 * ignorait le template mais tapait une suggestion RCS reçue par ailleurs était compté « a répondu » ET « a
 * tapé un bouton » de la campagne WhatsApp (une suggestion RCS est enregistrée avec `type='button'`).
 * L'opérateur jugeait son template sur le taux de clic d'un autre canal. Les deux colonnes sont
 * `not null default 'whatsapp'` depuis la migration 0056 : l'égalité simple suffit, pas de coalesce.
 */
const entrantAttribue = (extra = ''): string => `r.sent_at is not null and exists (
           select 1 from conversations cv
             join conversation_messages m on m.conversation_id = cv.id
           where cv.tenant_id = c.tenant_id and not cv.is_test
             and cv.wa_id = regexp_replace(r.to_e164, '[^0-9]', '', 'g')
             and m.direction = 'in'
             and m.channel = c.channel
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
    //    🔴 `c.channel = 'whatsapp'` : une campagne RCS n'envoie AUCUN template. Sans ce filtre, 5 000 envois
    //    RCS grossissaient la série « templates » d'un écran qui parle de Meta.
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

    // 3) Messages hors template / jour. UNE requête pour deux lectures : les ÉCHANGÉS (entrants + sortants)
    //    et, dans le même passage, les seuls SORTANTS, qui sont les messages de service. Un second balayage de
    //    la même table pour un sous-ensemble ne serait qu'un coût de plus.
    //    🔴 Les ÉCHANGÉS restent tous canaux (c'est un volume, les deux tuyaux comptent), mais les SORTANTS
    //    de service sont restreints à WhatsApp : cette série affirme à l'écran que Meta ne les facture pas au
    //    message, or smsmode facture bien les envois RCS. Le RCS n'a pas encore de série à lui, il vaut donc
    //    mieux ne pas le montrer que le montrer comme gratuit.
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

    // 4) Ventilation des SEULS messages de service par origine. Même filtre exactement que la colonne
    //    `sortants` ci-dessus (sortant, hors template, WhatsApp, hors fil de test), pour que le total de la
    //    ventilation retombe sur celui de la courbe. Un filtre qui diverge d'un mot ferait mentir les deux.
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
    for (const ligne of parOrigine.rows) {
      // Une valeur d'origine inconnue de la table de correspondance tombe en « indéterminée » plutôt que
      // d'être perdue : c'est le seul comportement qui garde le total juste.
      const theme = THEME_DE_ORIGINE[ligne.origine] ?? 'indeterminee';
      serviceParOrigine[theme] += Number(ligne.n);
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
      templates: { utility, marketing },
      exchanged: exchanged.rows.map((r) => ({ date: r.d, count: Number(r.count) })),
      service: exchanged.rows.map((r) => ({ date: r.d, count: Number(r.sortants) })),
      serviceParOrigine,
    };
  }

  /**
   * Volume par template envoyé sur la période (campagnes + envois inbox), pour le dropdown du
   * dashboard et le prix estimé. Exclut les livraisons en échec (delivery_status='failed').
   *
   * 🔴 `c.channel = 'whatsapp'` et `nullif(c.template_name, '')` : une campagne RCS n'a pas de template, et
   * elle stocke la CHAÎNE VIDE et non null (http/campaigns.ts), donc elle traversait tous les filtres écrits
   * pour null. Elle apparaissait ici en ligne au nom vide, et son volume était facturé au tarif Meta.
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
   * Breakdown des codes d'erreur Meta sur la plage (campagnes du tenant), trié par occurrences décroissantes.
   *
   * Population et ancrage viennent de `echecs-sql.ts`, comme le journal d'exploitation et les compteurs de
   * campagne : c'est ce qui garantit qu'un clic sur « 12 » ouvre exactement 12 lignes dans la liste des
   * contacts touchés, laquelle est servie par `PgErreursLivraisonStore.lister`.
   *
   * 🔴 CE QUE CE BREAKDOWN NE PEUT PAS MONTRER, parce qu'il est PAR CODE : un échec sans code Meta. Il en
   * existe (`src/campaign/engine.ts` marque `failed` sans code quand un template ou un carrousel est
   * inenvoyable, et toute panne réseau fait de même) : **2 sur 25** en production, mesurés le 2026-09-07.
   * Ils vivent dans le journal des erreurs de livraison (Paramètres), et l'écran d'Analytics doit le DIRE
   * plutôt que de laisser croire à un inventaire complet.
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
   * Volume d'envois de template FACTURABLES par (jour Paris, catégorie) sur la plage, filtrable par
   * campagne OU par template. Base du graphe de coût estimé (multiplié ensuite par le tarif Meta de la
   * catégorie).
   *
   * ⚠️ Ce docblock a décrit la seule branche campagne jusqu'au 2026-09-07, et il est devenu faux le jour où
   * la requête a gagné les envois HORS campagne. Ce qu'il faut savoir aujourd'hui :
   *  - la population et ses gardes vivent dans `envoisTemplateFacturables`, pas ici. C'est LUI qui porte
   *    `c.channel = 'whatsapp'` (le coût est au tarif Meta ; une campagne RCS part chez smsmode et Meta ne
   *    facture rien, l'y compter affichait un coût WhatsApp inexistant sur l'écran même où le client décide
   *    de son budget) ;
   *  - les deux branches ne s'ancrent PAS sur la même colonne : `sent_at` côté campagne, `created_at` côté
   *    hors campagne, et seule la première connaît `status` et `delivery_status` ;
   *  - `category` peut être `null` (un envoi de scénario antérieur au 2026-09-07 n'en porte pas), et
   *    `estimateCostSeries` ignore alors la ligne.
   */
  async getCostVolume(tenantId: string, range: DateRange, filter: CostFilter): Promise<CostVolumeRow[]> {
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
