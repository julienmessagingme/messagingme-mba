import type { Pool } from 'pg';
import { STATS_TZ, BOUNDS_CTE, addDays, isValidDateStr } from '../stats/range';

/**
 * Le récap de la veille : ce que le SQL compte, et lui seul. Le modèle ne compte jamais, comparaison avec la
 * semaine précédente comprise : les gens agissent sur un chiffre.
 *
 * Deux sources : `conversation_analysis.created_at` est réécrit à chaque ré-analyse (date de dernière analyse,
 * pas de la conversation). Le volume se lit donc sur `conversations` et `conversation_messages` à leurs vraies
 * dates, et les thèmes sur `conversation_analysis` rattachés aux conversations retenues.
 *
 * « Une conversation d'hier » est une conversation qui a parlé hier, pas créée hier : une conversation est
 * unique par `(tenant_id, wa_id)` pour toujours, un habitué qui réécrit n'ouvre aucune ligne. Les ouvertures
 * sont comptées à part (`conversationsNouvelles`).
 *
 * `not c.is_test` sur chaque requête, comme les requêtes sœurs des stats : une conversation marquée comme test
 * n'entre pas dans « hier : X conversations ». Plus rien ne pose ce marquage depuis le 2026-10-03 : un essai du
 * client depuis son téléphone y compte désormais.
 *
 * 🔴 `tenant_id = $1` sur chaque requête : `conversation_messages` n'a pas de `tenant_id`, l'isolation passe
 * par la jointure sur `conversations`.
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
  /** ...dont celles ouvertes ce jour-là (premier échange de ce numéro dans cet espace). */
  conversationsNouvelles: number;
  /**
   * ...et combien d'entre elles portent une analyse. L'analyse ne tourne qu'à l'inactivité : le récap est
   * toujours incomplet, et doit le dire plutôt que sous-déclarer sans prévenir.
   */
  conversationsAnalysees: number;
  messagesEntrants: number;
  messagesSortants: number;
  /** Les cinq premiers sujets, du plus fréquent au moins fréquent. */
  themes: RecapTheme[];
  /**
   * Le même jour de la semaine précédente (un lundi se compare à un lundi), pour que la comparaison soit
   * calculée plutôt que laissée au modèle. Ses thèmes n'arrivent que par leur nom : ils servent à repérer les
   * nouveaux, l'analyse partielle ne permet pas de comparer des volumes de sujets.
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
 * Le volume d'une journée civile. Les bornes viennent de `BOUNDS_CTE` (`src/stats/range.ts`) avec
 * `$2 = $3 = le jour`, dans le fuseau passé en `$4` : une soustraction naïve décalerait les journées au
 * changement d'heure.
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
 * Les thèmes de la journée : ceux des conversations qui ont parlé ce jour-là, quelle que soit la date de leur
 * analyse. `lower(btrim(topic))` comme ailleurs dans le dépôt, sinon deux casses font deux sujets. Le compte
 * des analysées et la liste sortent de la même requête, pour que le compte existe même quand aucun sujet
 * n'est rendu.
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
 * Le récap d'un jour. Le jour est choisi par l'appelant (la route calcule la veille), jamais par le client :
 * le contrôle de forme est une ceinture contre une faute de programmation, pas une validation d'entrée.
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
