import type { Pool } from 'pg';
import { STATS_TZ, BOUNDS_CTE } from './range';
import type { DateRange } from './range';
import { retentionEffective } from '../inbox/retention';

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

/**
 * CE QU UNE JOURNEE D ANALYSE VAUT, EN UNE SEULE EXPRESSION SQL, PARTAGEE PAR SES DEUX LECTEURS.
 *
 * 🔴 C EST LA CONTREPARTIE DU CHOIX DE JULIEN (2026-09-17) : « les vraies donnees font foi tant qu elles
 * existent », les agregats au-dela. Deux sources repondent donc a la MEME question sur deux portions de
 * l axe du temps, et le jour ou elles divergent d une unite, la frontiere des 90 jours fait une MARCHE
 * dans le graphe, indiscernable d un vrai creux d activite. Personne ne la verrait, et personne ne saurait
 * laquelle des deux a raison.
 *
 * La parade n est pas la vigilance, c est qu il n y ait qu UNE expression : la lecture en direct et
 * l ecriture de l agregat l importent toutes les deux, elles ne peuvent donc pas se contredire. Meme
 * mecanique que `ORIGINE_EFFECTIVE_SQL` (`src/inbox/origine.ts`), pour la meme raison, et un test
 * structurel verifie que les deux requetes la citent au lieu de la recopier.
 *
 * ⚠️ DES SOMMES ET DES COMPTES, JAMAIS UNE MOYENNE. Une moyenne stockee ne se re-agrege pas : regrouper
 * sept journees moyennes sans leur poids donne une moyenne de moyennes, fausse des que les journees n ont
 * pas le meme nombre de mesures. La moyenne se recalcule a l affichage, a n importe quelle maille.
 *
 * ⚠️ LES SIX INTENTIONS SONT COMPTEES UNE PAR UNE, et pas par un `jsonb_object_agg` : celui-ci echouerait
 * sur des cles dupliquees, et l enumeration est FERMEE de toute facon (`src/analysis/schema.ts`). Une
 * septieme valeur ferait echouer la validation de l analyse bien avant d arriver ici.
 *
 * ⚠️ `ca` EST L ALIAS ATTENDU de `conversation_analysis`, et `$4` le fuseau : les deux requetes qui
 * l utilisent doivent les fournir.
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
           'autre', count(*) filter (where ca.intent = 'autre')
         ) as intentions`;


export interface ConversationAnalysisSummary {
  /** Feature d'analyse active côté serveur (config). Distingue « inactif » de « aucune donnée ». */
  enabled: boolean;
  /**
   * Combien de jours une conversation reste consultable DANS CET ESPACE, purge du worker comprise. `0` veut
   * dire « jamais purgée ».
   *
   * Remonté avec les agrégats, comme `enabled`, et pour la même raison : l'écran doit pouvoir DIRE pourquoi
   * une plage ancienne rend moins de lignes que prévu. Sans cette phrase, un export plus court que la
   * période demandée passe pour un bug, et c'est le genre de doute qui coûte un aller-retour de support.
   *
   * 🔴 CE N'EST PLUS `CONVERSATION_RETENTION_DAYS` TEL QUEL, et cette ligne l'a affirmé à tort jusqu'au
   * 2026-09-17 : depuis la migration 0155, un espace peut poser SA durée, et c'est la sienne qui décide.
   * La règle à deux niveaux vit dans `retentionEffective` (`src/inbox/retention.ts`), partagée avec la purge.
   */
  retentionDays: number;
  total: number;
  sentiment: { positif: number; neutre: number; negatif: number };
  intent: { demande_devis: number; sav: number; reclamation: number; information: number; prise_rdv: number; autre: number };
  resolution: { resolved: number; unresolved: number; rate: number | null }; // rate 0..1, null si total=0
  handledBy: { humain: number; automatise: number; mba: number };
  exchanges: { avg: number | null; median: number | null };
  actions: { creer_devis: number; rappeler: number; relancer: number; escalader: number; aucune: number };
  topTopics: Array<{ topic: string; count: number }>;
  /**
   * Les sujets les plus frequents DE CHAQUE INTENTION, cinq au plus (2026-09-17).
   *
   * ⚠️ CE N'EST PAS UNE DÉCOUPE DE `topTopics` : celui-là classe les dix premiers TOUTES intentions
   * confondues, celui-ci en garde cinq PAR intention, donc il en montre que l'autre n'aurait jamais.
   * Un sujet fréquent dans une intention rare n'entre pas dans les dix premiers, et c'est justement
   * celui qu'on veut voir quand on déplie cette intention.
   */
  topicsParIntention: Record<string, Array<{ topic: string; count: number }>>;
  confidence: { lt50: number; from50to70: number; from70to90: number; gte90: number };
}

/**
 * Le nuage « satisfaction x urgence » de la page de synthèse (lot F, migration 0121).
 *
 * 🔴 CE N'EST PAS UNE LISTE DE CONVERSATIONS, c'est un DAMIER. Les deux notes sont des entiers de 0 à 10 :
 * il n'existe donc que 121 positions possibles, et une conversation de plus ne fait que grossir un point
 * existant. On agrège en base plutôt que de descendre une ligne par conversation, ce qui borne la réponse
 * quoi qu'il arrive (144 lignes au pire, cases incomplètes comprises) au lieu de la faire croître avec le
 * trafic du client.
 */
export interface NuageQualitatif {
  /** Une case occupée du damier : `n` conversations portent ce couple de notes. */
  points: Array<{ satisfaction: number; urgence: number; n: number }>;
  /** Moyenne des deux notes sur les conversations MESURÉES uniquement. `null` si aucune. */
  moyenne: { satisfaction: number; urgence: number } | null;
  /** Combien de conversations analysées de la plage portent les DEUX mesures. */
  mesurees: number;
  /**
   * ...et combien n'en portent pas.
   *
   * 🔴 Ce compte est la raison d'être du reste. Les analyses d'avant la migration 0121 n'ont pas de mesure,
   * et il n'y en aura jamais (on ne réanalyse pas). Un nuage qui les tairait laisserait croire que la
   * période ne contient que ce qu'il montre ; un nuage qui les placerait en (0,0) affirmerait que ces
   * clients étaient furieux et sans urgence. Il les compte à part, et l'écran le dit.
   */
  sansMesure: number;
}

export interface AnalyzedConversationsFilter {
  sentiment?: string;
  intent?: string;
  action?: string;
  /**
   * Sujet, en texte libre : c'est le LLM qui l'écrit, il n'y a donc pas d'énumération à valider. La
   * comparaison se fait sur `lower(btrim(...))` DES DEUX CÔTÉS, exactement comme le regroupement des sujets
   * fréquents : sans ça, cliquer une pastille « retard de livraison » ne ramènerait pas les lignes écrites
   * « Retard de livraison ». La valeur part en paramètre lié, jamais dans le texte de la requête.
   */
  topic?: string;
  limit?: number;
}

/**
 * UNE JOURNEE D ANALYSE, telle que l ecran « Analyse des conversations » la rend (2026-09-17).
 *
 * 🔴 UNE LIGNE PAR JOUR, PAS PAR CONVERSATION, ET C EST LA DEMANDE DE JULIEN. « Si un moment il y a 1000
 * conversations en stock, tu vas pas afficher 1000 conversations dans le tableau. » La table reste bornee
 * par la duree de la periode au lieu de croitre avec le trafic du client, et le detail d une journee se
 * demande en la cliquant.
 *
 * ⚠️ LES DEUX MOYENNES SONT NULLABLES, ET `null` N EST PAS `0`. Une journee dont aucune analyse ne porte
 * les notes (elles sont neuves depuis la migration 0121) n a pas une satisfaction de zero, elle n en a
 * pas. Les compter comme zero rangerait ces journees dans le coin « clients furieux ».
 */
export interface JourAnalyse {
  /** Le jour, en ISO court, dans le fuseau de l espace. */
  jour: string;
  conversations: number;
  /** Moyenne des analyses de la journee QUI PORTENT la note. `null` si aucune. */
  satisfaction: number | null;
  urgence: number | null;
  /** Combien d analyses de la journee portent les deux notes : c est le denominateur des moyennes. */
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
  /** Ce qui s'est DIT (migration 0100). `null` pour les analyses d'avant : l'écran l'annonce au lieu de
   *  laisser un blanc, et ne le remplace jamais par `justification`, qui répond à une autre question. */
  summary: string | null;
  /** Infos extraites par l'analyse (produit, budget, quantité...). Déjà stockées, jamais montrées avant :
   *  c'est la fiche de conversation qui leur donne enfin un endroit où servir. */
  entities: Record<string, unknown>;
  /**
   * LES ORIGINES DES MESSAGES SORTANTS de la conversation, dedoublonnees (migration 0099).
   *
   * 🔴 C'EST DE LA QUE SE DERIVENT LES BADGES « qui a repondu », ET SURTOUT PAS DE `handledBy`, qui ne rend
   * que 'humain' ou 'automatise' et dont la valeur 'mba' n'est JAMAIS produite. Une conversation menee par
   * l'agent de Meta y serait indiscernable d'un scenario, ce qui est exactement la distinction demandee.
   *
   * ⚠️ UNE LISTE VIDE EST UN CAS NORMAL : une conversation dont tous les sortants sont anterieurs a la
   * migration 0099 n'a aucune origine. L'ecran n'affiche alors aucun badge, plutot que d'en inventer un.
   */
  origines: string[];
}

/** La forme brute que rend `AGREGAT_JOUR_SQL`, et celle que rend la table d agregats : la MEME. */
interface LigneAgregat {
  jour: string;
  n: number;
  mes: number;
  som_sat: string | number | null;
  som_urg: string | number | null;
  intentions: Record<string, number> | null;
}

/**
 * D une ligne brute a une journee affichable.
 *
 * 🔴 LA MOYENNE SE CALCULE ICI, A PARTIR DE LA SOMME ET DU COMPTE, et jamais en base. C est ce qui permet
 * de regrouper par semaine sans faire une moyenne de moyennes, qui serait fausse des que deux journees
 * n ont pas le meme nombre de mesures.
 *
 * ⚠️ `null` QUAND AUCUNE MESURE, jamais zero : zero est une note VALIDE et la pire de toutes. Les analyses
 * d avant la migration 0121 n en portent aucune, et les compter comme zero rangerait tout l historique
 * dans le coin « clients furieux ».
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
     * LES SUJETS, RANGES SOUS LEUR INTENTION (demande de Julien du 2026-09-17).
     *
     * 🔴 CE QUE CE REGROUPEMENT REND VISIBLE, ET QUI EST LE VRAI SUJET. Les six intentions sont une
     * énumération FERMÉE : le modèle ne peut pas en inventer une septième. Le `topic`, lui, est du texte
     * LIBRE, et c'est là que vit l'inflation que Julien redoutait. Mesuré en production le 2026-09-17 :
     * 13 sujets distincts pour 14 analyses, dont QUATRE variantes de « consultation tarifs ». Rangés à plat
     * dans une liste, ces quatre-là sont dispersés et personne ne voit qu'ils sont parents ; sous
     * « Information », ils se retrouvent côte à côte et le problème se voit tout seul.
     *
     * ⚠️ `lower(btrim(...))` COMME `topTopics` JUSTE AU-DESSUS, et surtout pas une autre normalisation :
     * deux regroupements différents donneraient deux comptes pour le même sujet sur le même écran. Ce
     * n'est PAS un rapprochement sémantique pour autant : « tarifs et offres » et « tarifs cinéma »
     * resteront deux lignes, et c'est exactement ce qu'on veut montrer.
     *
     * ⚠️ CINQ PAR INTENTION, borné EN SQL par une fenêtre. Le nombre de sujets distincts n'a aucune borne
     * naturelle : une année d'échanges en produirait des centaines, dans un accordéon qu'on déplie pour se
     * faire une idée.
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
       * 🔴 CELLE DE L'ESPACE QUAND IL EN A UNE, PAS CELLE DE L'INSTANCE. `this.retentionDays` est fige au
       * demarrage du process et vaut pour tout le monde : l'annoncer tel quel ferait dire « conservees 90
       * jours » a un espace regle sur 30, pendant que ses donnees disparaissent a 30. La regle a deux
       * niveaux vit dans `retentionEffective`, partagee avec la purge, pour qu'il n'y en ait pas deux.
       */
      retentionDays: retentionEffective(this.retentionDays, r.retention_espace ?? null),
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
      topicsParIntention,
      confidence: { lt50: Number(r.c_lt50), from50to70: Number(r.c_50_70), from70to90: Number(r.c_70_90), gte90: Number(r.c_gte90) },
    };
  }

  /**
   * Le damier « satisfaction x urgence » de la plage, plus ce qu'il ne peut pas montrer.
   *
   * ⚠️ UNE SEULE REQUÊTE, et la moyenne se calcule ICI à partir de ses lignes, pas dans un second `avg()`.
   * Deux requêtes verraient deux instants différents (une analyse peut s'écrire entre les deux) et
   * afficheraient une moyenne qui ne tombe pas dans son propre nuage, ce qui se remarque à l'œil et ne
   * s'explique pas. Le regroupement rend au plus 144 lignes, la somme pondérée est donc exacte et gratuite.
   *
   * Les fils de TEST sont écartés comme dans `getSummary` : même population, sinon les deux écrans du même
   * onglet compteraient des choses différentes sous le même mot.
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
      // 🔴 Le test porte sur `null`, pas sur la fausseté : `0` est une mesure PARFAITEMENT valide (client
      // très mécontent, ou aucune urgence). Un `if (!r.satisfaction)` rangerait ces conversations parmi les
      // non mesurées, c'est-à-dire ferait disparaître du nuage exactement les points qui alarment.
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

  /** N dernières conversations analysées de la plage, filtrables. Join conversations (wa_id) + contacts
   *  (profile_name), lien inbox `/inbox?c=<id>`. Filtres validés côté route (enum), passés en $ nullable. */
  /**
   * 🔴 LES ORIGINES DES SORTANTS VOYAGENT AVEC CHAQUE LIGNE, ET C'EST DE LÀ QUE SE DÉRIVENT LES BADGES
   * « qui a répondu » (2026-09-17).
   *
   * SURTOUT PAS depuis `handled_by` : `deduceHandledBy` (`src/analysis/engine.ts`) ne rend que `humain` ou
   * `automatise`, et sa valeur `mba` est déclarée dans l'énumération mais n'est JAMAIS produite. Mesuré en
   * production le 2026-09-17 : sur 14 analyses, 8 `automatise` et 6 `humain`, zéro `mba`. Une conversation
   * menée par l'agent de Meta y est donc indiscernable d'un scénario, ce qui est exactement la distinction
   * demandée. `conversation_messages.origin` (migration 0099), lui, porte les cinq valeurs pour de vrai.
   *
   * ⚠️ SOUS-REQUÊTE CORRÉLÉE plutôt qu'une jointure : une jointure multiplierait la ligne d'analyse par son
   * nombre de messages, et il faudrait la dégrouper ensuite. Elle sert l'index partiel
   * `conversation_messages_origin_idx`, dont le prédicat est exactement `(conversation_id, created_at)
   * where direction = 'out'`.
   */
  async listAnalyzed(tenantId: string, range: DateRange, filters: AnalyzedConversationsFilter): Promise<AnalyzedConversationRow[]> {
    const { from, to } = range;
    // Plafond relevé à 1000 (il était de 200) : c'est cette liste que l'écran exporte en CSV, et un export
    // silencieusement tronqué à 200 lignes est pire qu'un export refusé, parce que rien ne le signale. Le
    // plafond reste, lui, parce qu'une plage d'un an sans borne rendrait tout l'historique d'un coup.
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 1000);
    const res = await this.pool.query<{
      conversation_id: string; wa_id: string; profile_name: string | null;
      sentiment: string; intent: string; topic: string; resolved: boolean; action_suggestion: string;
      confidence: number; justification: string; handled_by: string; exchanges_count: number; created_at: Date;
      summary: string | null; entities: Record<string, unknown> | null; origines: string[] | null;
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
                           and m.origin is not null), '{}') as origines
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
      origines: Array.isArray(r.origines) ? r.origines : [],
      entities: r.entities ?? {},
    }));
  }

  /**
   * LES JOURNEES DE LA PERIODE, LUES SUR LE CONTENU ENCORE PRESENT.
   *
   * 🔴 ELLE CITE `AGREGAT_JOUR_SQL`, ELLE NE LE RECOPIE PAS, et c est tout ce qui empeche la marche a la
   * frontiere des 90 jours : le balayage qui remplit `analyse_jour` cite EXACTEMENT la meme expression.
   * Deux redactions de la meme somme divergeraient au premier changement, et l ecart serait pris pour un
   * vrai creux d activite.
   *
   * ⚠️ LES JOURNEES SANS AUCUNE CONVERSATION N APPARAISSENT PAS, et ce n est pas un oubli : un `group by`
   * ne rend que ce qui existe. C est ce que l ecran veut (une ligne a zero n apprend rien et noie les
   * autres), et c est dit ici pour que personne ne « repare » en densifiant la serie.
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
   * LES JOURNEES DEJA AGREGEES, celles dont le contenu a ete efface par la retention.
   *
   * ⚠️ AUCUN CALCUL ICI : les sommes et les comptes sont stockes tels quels, et la moyenne se refait a
   * l affichage. Stocker une moyenne aurait interdit de regrouper par semaine sans la fausser.
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
   * LES JOURNEES DE LA PERIODE, D OU QU ELLES VIENNENT.
   *
   * 🔴 LES VRAIES DONNEES FONT FOI TANT QU ELLES EXISTENT (choix de Julien du 2026-09-17), les agregats
   * comblent le reste. Une journee presente des DEUX cotes prend la version vivante : c est la seule
   * regle qui rende le resultat previsible, et les deux ne peuvent pas se contredire puisqu elles sortent
   * de la meme expression SQL.
   *
   * ⚠️ DEUX LECTURES EN PARALLELE et pas l une puis l autre : elles sont independantes, et cet ecran est
   * le premier que le client ouvre en arrivant sur l analyse.
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
   * ECRIT LES AGREGATS DE TOUTES LES JOURNEES ENCORE PRESENTES, de TOUS les espaces.
   *
   * ⚠️ UN tenantId A NULL VEUT DIRE « TOUS », et c est le cas courant : le balayage n a alors AUCUNE liste
   * d espaces a tenir, donc aucun espace cree entre deux passages ne peut lui echapper. Le passer sert aux
   * tests et a un rattrapage cible.
   *
   * 🔴 UNE SEULE INSTRUCTION POUR TOUTES LES JOURNEES, ET C EST CE QUI SUPPRIME L ORDRE DE DEPLOIEMENT.
   * Un balayage qui traiterait « la veille » a chaque passage laisserait, au premier demarrage apres le
   * passage a 90 jours, neuf mois d historique sans agregat, que la purge effacerait AVANT qu on ait eu le
   * temps de le calculer. Irrecuperable. Ici, un seul passage couvre tout ce qui existe.
   *
   * 🔴 IDEMPOTENTE PAR CONSTRUCTION (`on conflict do update` sur `(tenant_id, jour)`) : elle peut etre
   * rejouee, interrompue, relancee, sans jamais produire de doublon ni d etat partiel. C est ce qui permet
   * de l attendre AVANT la purge au demarrage du worker.
   *
   * ⚠️ ELLE CITE LE MEME `AGREGAT_JOUR_SQL` que la lecture en direct. Si un jour quelqu un recopie
   * l expression au lieu de la citer, `tests/agregats-jour.test.ts` le fait echouer.
   *
   * Rend le nombre de journees ecrites.
   */
  /**
   * LE PLUS ANCIEN JOUR D'ANALYSE ENCORE PRESENT EN BASE, au fuseau des statistiques. `null` si la table est
   * vide. Format `AAAA-MM-JJ`, celui que `DateRange` attend.
   *
   * 🔴 ELLE EXISTE POUR BORNER LE BALAYAGE PAR LA DONNEE, ET PAS PAR UN NOMBRE DEVINE. Le balayage remontait
   * 400 jours en dur, un peu plus que la plage maximale d'un ecran. Or un espace peut regler sa retention
   * jusqu'a 3650 jours, et le levier d'urgence (`CONVERSATION_RETENTION_DAYS = 0`) peut suspendre la purge
   * aussi longtemps qu'on veut : dans ces deux cas, des analyses de plus de 400 jours SURVIVENT, sortent de
   * la fenetre du balayage, et seraient effacees le jour ou la purge reprend sans avoir jamais ete agregees.
   * Perdues pour toujours, sans une erreur. Releve en revue le 2026-09-17, non atteignable ce jour-la (la
   * production envoie depuis le 2026-07-06, donc rien n'a 400 jours), mais ARME.
   *
   * ⚠️ ET LA FENETRE NE GROSSIT QUE QUAND LE RISQUE EXISTE : tant que rien ne depasse 400 jours, elle reste
   * a 400 jours. Elle s'etend exactement de ce qui pourrait etre perdu, jamais plus.
   */
  async plusAncienJourAnalyse(): Promise<string | null> {
    const res = await this.pool.query<{ jour: string | null }>(
      `select to_char(min(created_at) at time zone $1, 'YYYY-MM-DD') as jour from conversation_analysis`,
      [TZ],
    );
    return res.rows[0]?.jour ?? null;
  }

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
      // ⚠️ LES QUATRE MEMES PARAMETRES QUE LA LECTURE, dans le meme ordre, et TOUS references. Une premiere
      // version passait un intervalle et laissait $3 sans reference : Postgres refuse un parametre dont il
      // ne peut pas deduire le type, et aucun typecheck ne le voit.
      [tenantId, from, to, TZ],
    );
    return res.rowCount ?? 0;
  }
}
