import type { Pool } from 'pg';
import { STATS_TZ, BOUNDS_CTE } from './range';
import type { DateRange } from './range';
import { retentionEffective } from '../inbox/retention';
import { originesQuiRepondent } from '../inbox/origine';
import type { Intent } from '../analysis/schema';

/**
 * Lecture des agrégats d'analyse de conversation (`conversation_analysis`), séparée du store d'écriture
 * `src/analysis/store.pg.ts`. Aucun appel LLM : du SQL sur des colonnes déjà remplies. 🔴 `tenant_id = $1` sur
 * chaque requête, en plus de `scopeTenant` côté route.
 *
 * `conversation_analysis.created_at` est réécrit à chaque ré-analyse : c'est la date de dernière analyse, pas
 * de la conversation. L'agrégat est un instantané fenêtré, pas un registre historique.
 */

const TZ = STATS_TZ;

/**
 * Ce qu'une journée d'analyse vaut, en une seule expression SQL partagée par ses deux lecteurs : la lecture en
 * direct et l'écriture de l'agrégat (les vraies données font foi tant qu'elles existent, les agrégats au-delà).
 * Deux rédactions feraient une marche à la frontière de la rétention, indiscernable d'un creux d'activité ; un
 * test vérifie que les deux requêtes la citent.
 *
 * Des sommes et des comptes, jamais une moyenne : une moyenne stockée ne se ré-agrège pas. Les intentions sont
 * comptées une par une (`jsonb_object_agg` échouerait sur des clés dupliquées) ; une valeur ajoutée à `INTENTS`
 * doit l'être ici aussi, un test l'exige. `ca` = alias de `conversation_analysis`, `$4` = le fuseau.
 */
export const AGREGAT_JOUR_SQL = `
         to_char(date_trunc('day', ca.created_at at time zone $4), 'YYYY-MM-DD') as jour,
         count(*)::int as n,
         count(*) filter (where ca.satisfaction is not null and ca.urgence is not null)::int as mes,
         sum(ca.satisfaction) filter (where ca.satisfaction is not null and ca.urgence is not null)::float as som_sat,
         sum(ca.urgence) filter (where ca.satisfaction is not null and ca.urgence is not null)::float as som_urg,
         jsonb_build_object(
           'demande_devis', count(*) filter (where ca.intent = 'demande_devis'),
           'sav', count(*) filter (where ca.intent = 'sav'),
           'reclamation', count(*) filter (where ca.intent = 'reclamation'),
           'information', count(*) filter (where ca.intent = 'information'),
           'prise_rdv', count(*) filter (where ca.intent = 'prise_rdv'),
           'achat', count(*) filter (where ca.intent = 'achat'),
           'suivi_commande', count(*) filter (where ca.intent = 'suivi_commande'),
           'retour', count(*) filter (where ca.intent = 'retour'),
           'autre', count(*) filter (where ca.intent = 'autre')
         ) as intentions`;


export interface ConversationAnalysisSummary {
  /** Feature d'analyse active côté serveur (config). Distingue « inactif » de « aucune donnée ». */
  enabled: boolean;
  /**
   * Combien de jours une conversation reste consultable dans cet espace, purge comprise (`0` = jamais purgée),
   * pour que l'écran dise pourquoi une plage ancienne rend moins de lignes. C'est la durée de l'espace quand il
   * en a une, via `retentionEffective`.
   */
  retentionDays: number;
  total: number;
  sentiment: { positif: number; neutre: number; negatif: number };
  /** Une clé par valeur de `INTENTS` : un `Record` et pas un objet écrit à la main, pour qu'une intention
   *  ajoutée au schéma sans son compte ne compile pas. */
  intent: Record<Intent, number>;
  resolution: { resolved: number; unresolved: number; rate: number | null }; // rate 0..1, null si total=0
  handledBy: { humain: number; automatise: number; mba: number };
  exchanges: { avg: number | null; median: number | null };
  actions: { creer_devis: number; rappeler: number; relancer: number; escalader: number; aucune: number };
  topTopics: Array<{ topic: string; count: number }>;
  /**
   * Les sujets les plus fréquents de chaque intention, cinq au plus. Pas une découpe de `topTopics` (les dix
   * premiers toutes intentions confondues) : un sujet fréquent dans une intention rare n'y entrerait pas.
   */
  topicsParIntention: Record<string, Array<{ topic: string; count: number }>>;
  confidence: { lt50: number; from50to70: number; from70to90: number; gte90: number };
}

/**
 * Le nuage « satisfaction x urgence » de la page de synthèse. Un damier, pas une liste : les deux notes sont des
 * entiers de 0 à 10, on agrège en base, et la réponse reste bornée quel que soit le trafic.
 */
export interface NuageQualitatif {
  /** Une case occupée du damier : `n` conversations portent ce couple de notes. */
  points: Array<{ satisfaction: number; urgence: number; n: number }>;
  /** Moyenne des deux notes sur les conversations mesurées uniquement. `null` si aucune. */
  moyenne: { satisfaction: number; urgence: number } | null;
  /** Combien de conversations analysées de la plage portent les deux mesures. */
  mesurees: number;
  /**
   * ...et combien n'en portent pas (les anciennes analyses n'ont pas de mesure). Les taire laisserait croire que
   * la période ne contient que le nuage ; les placer en (0,0) les dirait furieuses et sans urgence.
   */
  sansMesure: number;
}

export interface AnalyzedConversationsFilter {
  sentiment?: string;
  intent?: string;
  action?: string;
  /**
   * Sujet, en texte libre écrit par le LLM. Comparé sur `lower(btrim(...))` des deux côtés, comme le
   * regroupement des sujets fréquents ; la valeur part en paramètre lié.
   */
  topic?: string;
  limit?: number;
}

/**
 * Une journée d'analyse, telle que l'écran la rend : une ligne par jour, pas par conversation, pour que la
 * table reste bornée par la durée de la période. Les deux moyennes sont nullables : `null` n'est pas `0`, une
 * journée sans note n'a pas une satisfaction de zéro.
 */
export interface JourAnalyse {
  /** Le jour, en ISO court, dans le fuseau de l'espace. */
  jour: string;
  conversations: number;
  /** Moyenne des analyses de la journée qui portent la note. `null` si aucune. */
  satisfaction: number | null;
  urgence: number | null;
  /** Combien d'analyses de la journée portent les deux notes : le dénominateur des moyennes. */
  mesurees: number;
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
  /** Ce qui s'est dit. `null` pour les analyses anciennes : l'écran l'annonce, sans le remplacer par
   *  `justification`, qui répond à une autre question. */
  summary: string | null;
  /** Infos extraites par l'analyse (produit, budget, quantité...), montrées par la fiche de conversation. */
  entities: Record<string, unknown>;
  /**
   * Les origines des messages sortants de la conversation, dédoublonnées : les badges « qui a répondu » s'en
   * dérivent, pas de `handledBy` (qui ne produit jamais `mba`). Liste vide = cas normal (sortants anciens),
   * aucun badge inventé. `api` n'y figure que si l'un de ses messages suit un entrant (`originesQuiRepondent`).
   */
  origines: string[];
}

/** La forme brute que rend `AGREGAT_JOUR_SQL`, et celle de la table d'agrégats : la même. */
interface LigneAgregat {
  jour: string;
  n: number;
  mes: number;
  som_sat: string | number | null;
  som_urg: string | number | null;
  intentions: Record<string, number> | null;
}

/**
 * D'une ligne brute à une journée affichable. La moyenne se calcule ici, à partir de la somme et du compte,
 * pour regrouper par semaine sans moyenne de moyennes. `null` quand aucune mesure, jamais zéro (zéro est une
 * note valide, la pire).
 */
function depuisAgregat(r: LigneAgregat): JourAnalyse {
  const mesurees = Number(r.mes);
  const sat = r.som_sat === null ? null : Number(r.som_sat);
  const urg = r.som_urg === null ? null : Number(r.som_urg);
  return {
    jour: r.jour,
    conversations: Number(r.n),
    satisfaction: mesurees > 0 && sat !== null ? sat / mesurees : null,
    urgence: mesurees > 0 && urg !== null ? urg / mesurees : null,
    mesurees,
  };
}
/** `enabled` injecté (= config.CONVERSATION_ANALYSIS_ENABLED === 'true') : la lecture d'agrégats ne coûte rien,
 *  mais on remonte l'état de la feature pour un empty-state différencié. */
export class PgConversationStatsStore {
  constructor(private readonly pool: Pool, private readonly enabled: boolean, private readonly retentionDays: number) {}

  async getSummary(tenantId: string, range: DateRange): Promise<ConversationAnalysisSummary> {
    const { from, to } = range;
    // Une passe : tous les compteurs par count(*) FILTER + avg + médiane (un seul scan de l'index).
    const agg = await this.pool.query<{
      total: string;
      s_pos: string; s_neu: string; s_neg: string;
      i_devis: string; i_sav: string; i_recl: string; i_info: string; i_rdv: string;
      i_achat: string; i_suivi: string; i_retour: string; i_autre: string;
      resolved: string; unresolved: string;
      h_humain: string; h_auto: string; h_mba: string;
      avg_ex: string | null; median_ex: string | null;
      a_devis: string; a_rappeler: string; a_relancer: string; a_escalader: string; a_aucune: string;
      c_lt50: string; c_50_70: string; c_70_90: string; c_gte90: string;
      retention_espace: number | null;
    }>(
      `with ${BOUNDS_CTE}
       select
         -- LA RETENTION DE CET ESPACE, remontee avec les compteurs plutot que par une requete de plus : la
         -- phrase qui l'annonce est affichee juste sous eux. null = l'espace n'a rien regle, et c'est
         -- retentionEffective qui tranche ensuite, pas ce select.
         (select ts.conversation_retention_days from tenant_settings ts where ts.tenant_id = $1) as retention_espace,
         count(*)::int as total,
         count(*) filter (where sentiment = 'positif')::int as s_pos,
         count(*) filter (where sentiment = 'neutre')::int as s_neu,
         count(*) filter (where sentiment = 'negatif')::int as s_neg,
         count(*) filter (where intent = 'demande_devis')::int as i_devis,
         count(*) filter (where intent = 'sav')::int as i_sav,
         count(*) filter (where intent = 'reclamation')::int as i_recl,
         count(*) filter (where intent = 'information')::int as i_info,
         count(*) filter (where intent = 'prise_rdv')::int as i_rdv,
         count(*) filter (where intent = 'achat')::int as i_achat,
         count(*) filter (where intent = 'suivi_commande')::int as i_suivi,
         count(*) filter (where intent = 'retour')::int as i_retour,
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
       where ca.tenant_id = $1 and ca.created_at >= b.start_ts and ca.created_at < b.end_ts
         -- Les fils de TEST (jeton de test d'un scénario) ne sont pas de vrais échanges client : ils ne pèsent
         -- pas dans le qualitatif. Ceinture-bretelles : ils sont déjà écartés de l'analyse en amont.
         and not exists (select 1 from conversations cv where cv.id = ca.conversation_id and cv.is_test)`,
      [tenantId, from, to, TZ],
    );

    // Top topics : GROUP BY séparé (cardinalité variable). lower(btrim) pour regrouper casse/espaces.
    const topics = await this.pool.query<{ topic: string; n: string }>(
      `with ${BOUNDS_CTE}
       select lower(btrim(topic)) as topic, count(*)::int as n
       from conversation_analysis ca, bounds b
       where ca.tenant_id = $1 and ca.created_at >= b.start_ts and ca.created_at < b.end_ts
         and btrim(topic) <> ''
         and not exists (select 1 from conversations cv where cv.id = ca.conversation_id and cv.is_test)
       group by 1 order by n desc, topic asc limit 10`,
      [tenantId, from, to, TZ],
    );

    /**
     * Les sujets rangés sous leur intention : les intentions sont une énumération fermée, le `topic` du texte
     * libre qui s'enfle de variantes proches ; rangées sous leur intention, elles se voient côte à côte. Même
     * normalisation `lower(btrim(...))` que `topTopics` (sinon deux comptes pour un sujet), pas de
     * rapprochement sémantique. Cinq par intention, bornés en SQL.
     */
    const parIntention = await this.pool.query<{ intent: string; topic: string; n: string }>(
      `with ${BOUNDS_CTE},
       brut as (
         select ca.intent as intent, lower(btrim(ca.topic)) as topic, count(*)::int as n
           from conversation_analysis ca, bounds b
          where ca.tenant_id = $1 and ca.created_at >= b.start_ts and ca.created_at < b.end_ts
            and btrim(ca.topic) <> ''
            and not exists (select 1 from conversations cv where cv.id = ca.conversation_id and cv.is_test)
          group by 1, 2
       ),
       classe as (
         select intent, topic, n,
                row_number() over (partition by intent order by n desc, topic asc) as rang
           from brut
       )
       select intent, topic, n from classe where rang <= 5 order by intent, rang`,
      [tenantId, from, to, TZ],
    );
    const topicsParIntention: Record<string, Array<{ topic: string; count: number }>> = {};
    for (const ligne of parIntention.rows) {
      (topicsParIntention[ligne.intent] ??= []).push({ topic: ligne.topic, count: Number(ligne.n) });
    }

    const r = agg.rows[0]!;
    const total = Number(r.total);
    const resolved = Number(r.resolved);
    return {
      enabled: this.enabled,
      /**
       * La durée de l'espace quand il en a une, pas celle de l'instance (figée au démarrage et valable pour
       * tous) : la règle à deux niveaux vit dans `retentionEffective`, partagée avec la purge.
       */
      retentionDays: retentionEffective(this.retentionDays, r.retention_espace ?? null),
      total,
      sentiment: { positif: Number(r.s_pos), neutre: Number(r.s_neu), negatif: Number(r.s_neg) },
      intent: {
        demande_devis: Number(r.i_devis), sav: Number(r.i_sav), reclamation: Number(r.i_recl),
        information: Number(r.i_info), prise_rdv: Number(r.i_rdv), achat: Number(r.i_achat),
        suivi_commande: Number(r.i_suivi), retour: Number(r.i_retour), autre: Number(r.i_autre),
      },
      resolution: { resolved, unresolved: Number(r.unresolved), rate: total > 0 ? resolved / total : null },
      handledBy: { humain: Number(r.h_humain), automatise: Number(r.h_auto), mba: Number(r.h_mba) },
      exchanges: { avg: r.avg_ex !== null ? Number(r.avg_ex) : null, median: r.median_ex !== null ? Number(r.median_ex) : null },
      actions: {
        creer_devis: Number(r.a_devis), rappeler: Number(r.a_rappeler), relancer: Number(r.a_relancer),
        escalader: Number(r.a_escalader), aucune: Number(r.a_aucune),
      },
      topTopics: topics.rows.map((t) => ({ topic: t.topic, count: Number(t.n) })),
      topicsParIntention,
      confidence: { lt50: Number(r.c_lt50), from50to70: Number(r.c_50_70), from70to90: Number(r.c_70_90), gte90: Number(r.c_gte90) },
    };
  }

  /**
   * Le damier « satisfaction x urgence » de la plage, plus ce qu'il ne peut pas montrer. Une seule requête, la
   * moyenne se calcule ici depuis ses lignes : un second `avg()` verrait un autre instant, et la moyenne ne
   * tomberait pas dans son propre nuage. Fils de test écartés comme dans `getSummary`.
   */
  async getNuageQualitatif(tenantId: string, range: DateRange): Promise<NuageQualitatif> {
    const { from, to } = range;
    const res = await this.pool.query<{ satisfaction: number | null; urgence: number | null; n: string }>(
      `with ${BOUNDS_CTE}
       select ca.satisfaction, ca.urgence, count(*)::int as n
       from conversation_analysis ca, bounds b
       where ca.tenant_id = $1 and ca.created_at >= b.start_ts and ca.created_at < b.end_ts
         and not exists (select 1 from conversations cv where cv.id = ca.conversation_id and cv.is_test)
       group by 1, 2`,
      [tenantId, from, to, TZ],
    );

    const points: NuageQualitatif['points'] = [];
    let mesurees = 0;
    let sansMesure = 0;
    let sommeSat = 0;
    let sommeUrg = 0;
    for (const r of res.rows) {
      const n = Number(r.n);
      // Le test porte sur `null`, pas sur la fausseté : `0` est une mesure valide, justement celle qui alarme.
      if (r.satisfaction === null || r.urgence === null) {
        sansMesure += n;
        continue;
      }
      points.push({ satisfaction: r.satisfaction, urgence: r.urgence, n });
      mesurees += n;
      sommeSat += r.satisfaction * n;
      sommeUrg += r.urgence * n;
    }
    // Ordre stable (ligne puis colonne) : le SQL n'en promet aucun sans `order by`, et une réponse dont
    // l'ordre bouge d'un appel à l'autre ferait clignoter les clés React du nuage.
    points.sort((a, b) => a.urgence - b.urgence || a.satisfaction - b.satisfaction);
    return {
      points,
      moyenne: mesurees > 0 ? { satisfaction: sommeSat / mesurees, urgence: sommeUrg / mesurees } : null,
      mesurees,
      sansMesure,
    };
  }

  /**
   * Les N dernières conversations analysées de la plage, filtrables (filtres validés côté route), avec le lien
   * inbox `/inbox?c=<id>`.
   *
   * Les origines des sortants voyagent avec chaque ligne : les badges « qui a répondu » s'en dérivent, jamais
   * de `handled_by` (`deduceHandledBy` ne produit jamais `mba`). Sous-requête corrélée plutôt que jointure (pas
   * de multiplication des lignes), servie par l'index partiel `conversation_messages_origin_idx`.
   */
  async listAnalyzed(tenantId: string, range: DateRange, filters: AnalyzedConversationsFilter): Promise<AnalyzedConversationRow[]> {
    const { from, to } = range;
    // Plafond à 1000 : cette liste est exportée en CSV, et un export tronqué en silence est pire qu'un refus.
    // Il reste un plafond, sinon une plage d'un an rendrait tout l'historique.
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 1000);
    const res = await this.pool.query<{
      conversation_id: string; wa_id: string; profile_name: string | null;
      sentiment: string; intent: string; topic: string; resolved: boolean; action_suggestion: string;
      confidence: number; justification: string; handled_by: string; exchanges_count: number; created_at: Date;
      summary: string | null; entities: Record<string, unknown> | null; origines: string[] | null;
      dernier_api: Date | null; premier_entrant: Date | null;
    }>(
      `with ${BOUNDS_CTE}
       select ca.conversation_id, c.wa_id, ct.profile_name,
              ca.sentiment, ca.intent, ca.topic, ca.resolved, ca.action_suggestion,
              ca.confidence, ca.justification, ca.handled_by, ca.exchanges_count, ca.created_at,
              ca.summary, ca.entities,
              -- QUI A REPONDU : les origines des messages sortants, dedoublonnees (migration 0099).
              -- La justification complete vit au-dessus de cette requete : elle contient des accents graves,
              -- qui refermeraient la chaine gabarit si on les ecrivait ici.
              coalesce((select array_agg(distinct m.origin)
                          from conversation_messages m
                         where m.conversation_id = ca.conversation_id and m.direction = 'out'
                           and m.origin is not null), '{}') as origines,
              -- Un message de l API ne repond que s il SUIT un entrant du meme fil : les deux instants qui
              -- le tranchent, la decision vit dans originesQuiRepondent (src/inbox/origine.ts).
              (select max(m.created_at) from conversation_messages m
                where m.conversation_id = ca.conversation_id and m.direction = 'out' and m.origin = 'api') as dernier_api,
              (select min(m.created_at) from conversation_messages m
                where m.conversation_id = ca.conversation_id and m.direction = 'in') as premier_entrant
       from conversation_analysis ca
         join conversations c on c.id = ca.conversation_id
         left join contacts ct on ct.id = c.contact_id, bounds b
       where ca.tenant_id = $1 and not c.is_test and ca.created_at >= b.start_ts and ca.created_at < b.end_ts
         and ($5::text is null or ca.sentiment = $5::text)
         and ($6::text is null or ca.intent = $6::text)
         and ($7::text is null or ca.action_suggestion = $7::text)
         -- Même normalisation des DEUX côtés que le regroupement des sujets fréquents de getSummary, sinon
         -- cliquer une pastille ne ramènerait pas les lignes de casse différente qu'elle a pourtant comptées.
         and ($8::text is null or lower(btrim(ca.topic)) = $8::text)
       order by ca.created_at desc
       limit $9`,
      [tenantId, from, to, TZ, filters.sentiment ?? null, filters.intent ?? null, filters.action ?? null,
        filters.topic !== undefined ? filters.topic.trim().toLowerCase() : null, limit],
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
      summary: r.summary,
      origines: originesQuiRepondent(Array.isArray(r.origines) ? r.origines : [], r.dernier_api, r.premier_entrant),
      entities: r.entities ?? {},
    }));
  }

  /**
   * Les journées de la période, lues sur le contenu encore présent. Elle cite `AGREGAT_JOUR_SQL`, comme le
   * balayage qui remplit `analyse_jour`. Les journées sans conversation n'apparaissent pas (un `group by` ne
   * rend que ce qui existe) : c'est voulu, ne pas densifier la série.
   */
  async parJour(tenantId: string, range: DateRange): Promise<JourAnalyse[]> {
    const { from, to } = range;
    const res = await this.pool.query<LigneAgregat>(
      `with ${BOUNDS_CTE}
       select ${AGREGAT_JOUR_SQL}
         from conversation_analysis ca, bounds b
        where ca.tenant_id = $1 and ca.created_at >= b.start_ts and ca.created_at < b.end_ts
          and not exists (select 1 from conversations cv where cv.id = ca.conversation_id and cv.is_test)
        group by 1
        order by 1 desc`,
      [tenantId, from, to, TZ],
    );
    return res.rows.map(depuisAgregat);
  }

  /**
   * Les journées déjà agrégées, celles dont le contenu a été effacé par la rétention. Aucun calcul ici : sommes
   * et comptes stockés tels quels, la moyenne se refait à l'affichage.
   */
  async parJourAgrege(tenantId: string, range: DateRange): Promise<JourAnalyse[]> {
    const { from, to } = range;
    const res = await this.pool.query<{ jour: string; n: number; mes: number; som_sat: string | null; som_urg: string | null; intentions: Record<string, number> | null }>(
      `select to_char(jour, 'YYYY-MM-DD') as jour, conversations as n, mesurees as mes,
              somme_satisfaction::float as som_sat, somme_urgence::float as som_urg, intentions
         from analyse_jour
        where tenant_id = $1 and jour >= $2::date and jour <= $3::date
        order by jour desc`,
      [tenantId, from, to],
    );
    return res.rows.map(depuisAgregat);
  }

  /**
   * Les journées de la période, d'où qu'elles viennent : les vraies données font foi tant qu'elles existent,
   * les agrégats comblent le reste (une journée présente des deux côtés prend la version vivante). Deux
   * lectures en parallèle.
   */
  async joursAnalyse(tenantId: string, range: DateRange): Promise<JourAnalyse[]> {
    const [vivants, agreges] = await Promise.all([
      this.parJour(tenantId, range),
      this.parJourAgrege(tenantId, range),
    ]);
    const vus = new Set(vivants.map((j) => j.jour));
    return [...vivants, ...agreges.filter((j) => !vus.has(j.jour))]
      .sort((a, b) => b.jour.localeCompare(a.jour));
  }

  /**
   * Le plus ancien jour d'analyse encore présent en base, au fuseau des stats (`AAAA-MM-JJ`), ou `null`.
   * 🔴 Borne le balayage d'agrégats par la donnée et non par un nombre deviné : une rétention longue ou une
   * purge suspendue laisserait sinon survivre des analyses hors de la fenêtre, effacées ensuite sans avoir été
   * agrégées. La fenêtre ne s'étend au-delà de 400 jours que si le risque existe.
   */
  async plusAncienJourAnalyse(): Promise<string | null> {
    const res = await this.pool.query<{ jour: string | null }>(
      `select to_char(min(created_at) at time zone $1, 'YYYY-MM-DD') as jour from conversation_analysis`,
      [TZ],
    );
    return res.rows[0]?.jour ?? null;
  }

  /**
   * Écrit les agrégats de toutes les journées encore présentes, de tous les espaces (`tenantId` null, le cas
   * courant : aucun espace ne peut échapper au balayage), et rend le nombre de journées écrites.
   *
   * 🔴 Une seule instruction pour toutes les journées : un balayage « de la veille » laisserait de l'historique
   * sans agrégat, que la purge effacerait. Idempotente (`on conflict do update` sur `(tenant_id, jour)`), elle
   * peut être rejouée ou interrompue sans doublon, et le worker l'attend avant la purge. Elle cite le même
   * `AGREGAT_JOUR_SQL` que la lecture en direct.
   */
  async ecrireAgregats(range: DateRange, tenantId: string | null = null): Promise<number> {
    const { from, to } = range;
    const res = await this.pool.query(
      `with ${BOUNDS_CTE}
       insert into analyse_jour (tenant_id, jour, conversations, mesurees, somme_satisfaction, somme_urgence, intentions, calcule_le)
       select j.tenant_id, j.jour::date, j.n, j.mes, j.som_sat, j.som_urg, j.intentions, now()
         from (
           select ca.tenant_id as tenant_id, ${AGREGAT_JOUR_SQL}
             from conversation_analysis ca, bounds b
            where ($1::uuid is null or ca.tenant_id = $1::uuid)
              and ca.created_at >= b.start_ts and ca.created_at < b.end_ts
              and not exists (select 1 from conversations cv where cv.id = ca.conversation_id and cv.is_test)
            group by 1, 2
         ) j
       on conflict (tenant_id, jour) do update set
         conversations = excluded.conversations,
         mesurees = excluded.mesurees,
         somme_satisfaction = excluded.somme_satisfaction,
         somme_urgence = excluded.somme_urgence,
         intentions = excluded.intentions,
         calcule_le = excluded.calcule_le
       -- 🔴 L AGREGAT NE DESCEND JAMAIS, ET SANS CETTE LIGNE LA TABLE ENREGISTRAIT LE RESIDU DE LA PURGE
       -- AU LIEU DE LA MEMOIRE DE LA JOURNEE. Le balayage recalcule chaque journee depuis les analyses
       -- ENCORE PRESENTES, or la purge est BORNEE (500 par passage) et son seuil est un INSTANT, pas une
       -- frontiere de journee civile : toute journee traverse donc un etat partiel. Sans garde :
       -- passage N, la journee vaut 800, la purge en efface 500 ; passage N+1, le balayage revoit 300 et
       -- REMPLACE 800 par 300 ; passage N+2, la journee ne produit plus aucune ligne, la mise a jour ne
       -- joue pas, et 300 reste pour toujours. La table existe precisement pour que ca n arrive pas.
       -- ⚠️ Le sens de l erreur residuelle est assume : une journee peut rester legerement SURCOMPTEE si
       -- un contact est supprime a la main. Surcompter un jour d historique est sans consequence ; le
       -- perdre est irreversible. Et analyse_jour ne porte aucune donnee personnelle, donc garder le
       -- compte d une conversation effacee n est pas une conservation deguisee, c est un nombre.
       where excluded.conversations >= analyse_jour.conversations`,
      // Les quatre mêmes paramètres que la lecture, dans le même ordre, et tous référencés : Postgres refuse un
      // paramètre dont il ne peut pas déduire le type, et aucun typecheck ne le voit.
      [tenantId, from, to, TZ],
    );
    return res.rowCount ?? 0;
  }
}
