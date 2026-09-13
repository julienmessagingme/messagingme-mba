import type { Pool } from 'pg';
import { STATS_TZ, BOUNDS_CTE, addDays, isValidDateStr } from '../stats/range';

/**
 * LE RÉCAP DE LA VEILLE : ce que le SQL compte, et lui seul.
 *
 * 🔴 LE MODÈLE NE COMPTE JAMAIS. Tout ce qui est chiffré sort d'ici, y compris la comparaison avec la
 * semaine précédente. Un chiffre faux dans un récap est pire que pas de récap, parce que les gens agissent
 * dessus : c'est la leçon de la migration 0126, où l'annonce d'IA était confiée au modèle et où le code a dû
 * reprendre la décision.
 *
 * 🔴 DEUX SOURCES, ET C'EST LE PIÈGE DU LOT. `conversation_analysis.created_at` est réécrit à `now()` à
 * chaque ré-analyse (upsert documenté dans `src/stats/conversation-stats.pg.ts`) : c'est la date de DERNIÈRE
 * ANALYSE, pas celle de la conversation. Un récap bâti dessus compterait les conversations ANALYSÉES hier,
 * donc y ferait entrer une conversation d'il y a trois jours ré-analysée hier, et en ferait sortir une
 * conversation tenue hier mais analysée ce matin. Personne ne le verrait et les chiffres seraient plausibles.
 * Le VOLUME se lit donc sur `conversations` et `conversation_messages` à leurs vraies dates, et les THÈMES
 * sur `conversation_analysis` RATTACHÉS aux conversations retenues, quelle que soit la date de leur analyse.
 *
 * 🔴 « UNE CONVERSATION D'HIER » = UNE CONVERSATION QUI A PARLÉ HIER, pas une conversation CRÉÉE hier, et
 * c'est une décision, pas un détail d'implémentation. Une conversation est unique par `(tenant_id, wa_id)`
 * POUR TOUJOURS (migration 0058) : chez un client installé, un habitué qui réécrit n'ouvre aucune ligne
 * neuve. Compter les créations aurait donc rendu « hier : 2 conversations, 128 messages reçus », un couple
 * de chiffres visiblement incohérent qui aurait fait douter de tout l'écran. Les ouvertures restent comptées
 * à part (`conversationsNouvelles`), parce que « dont 3 nouvelles » est justement ce qu'on veut savoir.
 *
 * 🔴 `not c.is_test` SUR CHAQUE REQUÊTE, AU MÊME TITRE QUE `tenant_id`. La colonne existe depuis la
 * migration 0053 pour exactement ce cas : « ce fil vient d'un test interne, pas d'un vrai client [...] sert
 * à exclure ces conversations de l'analyse et des statistiques, pour qu'un essai ne ressemble pas à un lead
 * dans le tableau de bord ». TOUTES les requêtes soeurs la filtrent (`src/stats/store.pg.ts`,
 * `src/stats/conversation-stats.pg.ts`). L'oublier ici ferait entrer les essais du client depuis son propre
 * téléphone dans « hier : X conversations », et sur un petit espace quelques échanges de test suffisent à
 * fausser le chiffre visiblement, voire à déclencher un appel de modèle sur un écart qui n'existe pas.
 *
 * ⚠️ `tenant_id = $1` sur CHAQUE requête : `conversation_messages` n'a PAS de `tenant_id`, l'isolation passe
 * donc obligatoirement par la jointure sur `conversations`. C'est la PREMIÈRE lecture des données d'un
 * client par le bot d'aide, qui ne lisait jusqu'ici que `aide_fiches` (même corpus pour tout le monde).
 */

/** Un sujet de la journée, tel que l'analyse l'a écrit, regroupé sur `lower(btrim(...))`. */
export interface RecapTheme {
  topic: string;
  n: number;
}

export interface Recap {
  /** Le jour couvert, YYYY-MM-DD dans le fuseau des stats. */
  jour: string;
  /** Conversations qui ont porté au moins un message ce jour-là. */
  conversations: number;
  /** ...dont celles OUVERTES ce jour-là (premier échange de ce numéro dans cet espace). */
  conversationsNouvelles: number;
  /**
   * ...et combien d'entre elles portent une analyse.
   *
   * 🔴 L'ANALYSE NE TOURNE QU'À L'INACTIVITÉ, donc le récap est TOUJOURS incomplet : une conversation
   * d'hier soir encore vivante ce matin n'a pas de thème. Un récap qui annonce 42 conversations et n'en
   * thématise que 25 doit l'écrire, sinon il sous-déclare sans prévenir et quelqu'un conclura que le sujet
   * dont il se préoccupe n'est pas remonté.
   */
  conversationsAnalysees: number;
  messagesEntrants: number;
  messagesSortants: number;
  /** Les cinq premiers sujets, du plus fréquent au moins fréquent. */
  themes: RecapTheme[];
  /**
   * Le MÊME JOUR la semaine précédente, pour que la comparaison soit vraie plutôt que laissée au modèle.
   *
   * ⚠️ Le même jour de la SEMAINE, pas l'avant-veille : un lundi se compare à un lundi, sinon le récap du
   * lundi annoncerait un effondrement chaque semaine en se comparant au dimanche.
   *
   * ⚠️ Ses thèmes n'arrivent que par leur NOM, sans compte : ils ne servent qu'à savoir lesquels sont
   * nouveaux. Leur donner un compte laisserait croire qu'on peut comparer des volumes de sujets, ce que
   * l'analyse partielle de la veille ne permet pas honnêtement.
   */
  semainePrecedente: {
    conversations: number;
    messagesEntrants: number;
    themes: string[];
  };
}

/** Combien de sujets partent à l'écran. Cinq tiennent dans une phrase, au-delà c'est une liste. */
const THEMES_RENDUS = 5;

/** Ce qu'une journée mesurée rend, avant d'être assemblée en récap. */
interface Journee {
  conversations: number;
  conversationsNouvelles: number;
  conversationsAnalysees: number;
  messagesEntrants: number;
  messagesSortants: number;
  themes: RecapTheme[];
}

/**
 * Le volume d'une journée civile.
 *
 * ⚠️ LES BORNES VIENNENT DE `BOUNDS_CTE` (`src/stats/range.ts`), RÉUTILISÉ ET PAS RÉÉCRIT, avec
 * `$2 = $3 = le jour` : une seule journée, dans le fuseau passé en `$4`. C'est l'invariant de changement
 * d'heure du module (une soustraction naïve en secondes décalerait les journées deux fois par an), et le
 * récap est exactement l'écran qui raisonne en heure locale sur des mesures stockées en UTC.
 */
const VOLUME_SQL = `with ${BOUNDS_CTE},
       msgs as (
         select m.conversation_id, m.direction
           from conversation_messages m
           join conversations c on c.id = m.conversation_id
          cross join bounds b
          where c.tenant_id = $1 and not c.is_test
            and m.created_at >= b.start_ts and m.created_at < b.end_ts
       )
       select (select count(distinct conversation_id) from msgs)::int as conversations,
              (select count(*) from msgs where direction = 'in')::int as entrants,
              (select count(*) from msgs where direction = 'out')::int as sortants,
              (select count(*) from conversations c cross join bounds b
                where c.tenant_id = $1 and not c.is_test
                  and c.created_at >= b.start_ts and c.created_at < b.end_ts)::int as nouvelles`;

/**
 * Les thèmes de la journée : ceux des conversations qui ont PARLÉ ce jour-là, quelle que soit la date de
 * leur analyse. C'est ici que se joue le piège des deux sources.
 *
 * ⚠️ `lower(btrim(topic))` comme partout ailleurs dans le dépôt (`topTopics`, le filtre par sujet) : sans
 * ça, « Retard de livraison » et « retard de livraison » comptent pour deux sujets.
 *
 * ⚠️ Le COMPTE des conversations analysées et la LISTE des sujets sortent de la même requête, en un seul
 * parcours : les séparer laisserait le compte sans réponse les jours où aucun sujet n'est rendu, c'est-à-dire
 * précisément les jours où la phrase « tout n'est pas encore analysé » compte le plus.
 */
const THEMES_SQL = `with ${BOUNDS_CTE},
       actives as (
         select distinct m.conversation_id as id
           from conversation_messages m
           join conversations c on c.id = m.conversation_id
          cross join bounds b
          where c.tenant_id = $1 and not c.is_test
            and m.created_at >= b.start_ts and m.created_at < b.end_ts
       ),
       analysees as (
         select lower(btrim(an.topic)) as topic
           from actives a
           join conversation_analysis an on an.conversation_id = a.id and an.tenant_id = $1
       ),
       sommet as (
         select topic, count(*)::int as n
           from analysees
          where topic <> ''
          group by 1
          order by n desc, topic asc
          limit ${THEMES_RENDUS}
       )
       select (select count(*) from analysees)::int as analysees,
              coalesce((select json_agg(json_build_object('topic', topic, 'n', n) order by n desc, topic asc)
                          from sommet), '[]'::json) as themes`;

/**
 * Le récap d'un jour.
 *
 * ⚠️ LE JOUR EST CHOISI PAR L'APPELANT, JAMAIS PAR LE CLIENT : la route calcule toujours la veille, il n'y a
 * ni choix de date ni historique (décision de Julien, 2026-09-12 : « sinon trop compliqué »). Le contrôle de
 * forme ci-dessous est une ceinture contre une faute de programmation, pas une validation d'entrée.
 */
export function creerRecap(pool: Pool): (tenantId: string, jour: string) => Promise<Recap> {
  async function mesurer(tenantId: string, jour: string): Promise<Journee> {
    const params = [tenantId, jour, jour, STATS_TZ];
    const [vol, th] = await Promise.all([
      pool.query<{ conversations: number; entrants: number; sortants: number; nouvelles: number }>(VOLUME_SQL, params),
      pool.query<{ analysees: number; themes: RecapTheme[] }>(THEMES_SQL, params),
    ]);
    const v = vol.rows[0];
    const t = th.rows[0];
    return {
      conversations: v?.conversations ?? 0,
      conversationsNouvelles: v?.nouvelles ?? 0,
      conversationsAnalysees: t?.analysees ?? 0,
      messagesEntrants: v?.entrants ?? 0,
      messagesSortants: v?.sortants ?? 0,
      themes: t?.themes ?? [],
    };
  }

  return async (tenantId, jour) => {
    if (!isValidDateStr(jour)) throw new Error(`jour invalide : ${jour}`);
    const [journee, semainePrecedente] = await Promise.all([
      mesurer(tenantId, jour),
      mesurer(tenantId, addDays(jour, -7)),
    ]);
    return {
      jour,
      conversations: journee.conversations,
      conversationsNouvelles: journee.conversationsNouvelles,
      conversationsAnalysees: journee.conversationsAnalysees,
      messagesEntrants: journee.messagesEntrants,
      messagesSortants: journee.messagesSortants,
      themes: journee.themes,
      semainePrecedente: {
        conversations: semainePrecedente.conversations,
        messagesEntrants: semainePrecedente.messagesEntrants,
        themes: semainePrecedente.themes.map((t) => t.topic),
      },
    };
  };
}
