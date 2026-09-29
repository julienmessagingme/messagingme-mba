import type { Pool } from 'pg';
import { BOUNDS_CTE, STATS_TZ, type DateRange } from './range';
import { TYPES_FIN, TYPES_OUVERTURE, type DemandeBrute, type Qui } from './performance';

/**
 * La migration qui a ouvert la mesure : avant elle, le journal ne datait ni le passage d'un scénario ou d'un agent
 * IA à l'équipe, ni le retour au scénario. Sa date d'application dans `schema_migrations` est le « mesuré depuis »
 * de l'écran, et la borne basse de toute demande. `tests/migration-0194.test.ts` vérifie que le fichier porte ce nom.
 */
export const MIGRATION_DES_DEMANDES = '0194_evenements_demandes.sql';

/**
 * Un message ENTRANT qui attend une réponse, alias `m` : tout ce que le client envoie, sauf une réaction (un 👍
 * n'appelle pas de réponse, et lancerait le chrono d'une équipe que personne n'a sollicitée). `is distinct from` :
 * un type nul reste un message.
 */
const ENTRANT_SQL = `(m.direction = 'in' and m.type is distinct from 'reaction')`;

/**
 * Un message qui dit à qui est la balle, alias `m` : un entrant (`ENTRANT_SQL`), un modèle sortant, un message écrit
 * par un collaborateur (`origin = 'humain'`), ou un envoi de campagne, modèle WhatsApp comme message RCS (`origin =
 * 'campagne'`) : c'est notre prise de parole, et après elle la balle est chez le client. Les réponses d'un robot
 * (scénario, agent IA, agent de Meta), modèles à part, ne comptent pas : un robot qui répond ne rend pas la balle au
 * client. Le début d'une demande se lit dessus (`src/stats/performance.ts`).
 */
const MESSAGE_SIGNIFICATIF_SQL = `(${ENTRANT_SQL} or (m.direction = 'out' and (m.type = 'template' or m.origin in ('humain', 'campagne'))))`;

interface LigneDemande {
  conversation_id: string;
  debut_le: Date;
  jour: string;
  dans_la_periode: boolean;
  repondu_le: Date | null;
  repondant_id: string | null;
  repondant_nom: string | null;
  derniere_reponse_le: Date | null;
  close_le: Date | null;
  clos_par_id: string | null;
  clos_par_nom: string | null;
  clos_par_acteur: boolean;
  clos_cause: string | null;
}

/**
 * Qui a répondu : le collaborateur, s'il existe encore DANS l'espace ; sinon un ancien collaborateur (compte supprimé,
 * `sender_user_id` passé à null). Une réponse d'origine `humain` n'est jamais automatique.
 */
function repondantDe(r: LigneDemande): Qui | null {
  if (r.repondu_le === null) return null;
  return r.repondant_id !== null ? { genre: 'collaborateur', userId: r.repondant_id, nom: r.repondant_nom ?? '' } : { genre: 'ancien' };
}

/**
 * Qui a clos, selon la règle du journal (`src/inbox/evenements.ts`) : un acteur de l'espace ; un acteur qu'on ne
 * retrouve plus, ou nul SANS cause, est un collaborateur supprimé depuis ; nul AVEC une cause est un geste sans
 * auteur connu, dit automatique (délai de reprise, scénario qui reprend, clé d'API).
 */
function closeParDe(r: LigneDemande): Qui | null {
  if (r.close_le === null) return null;
  if (r.clos_par_id !== null) return { genre: 'collaborateur', userId: r.clos_par_id, nom: r.clos_par_nom ?? '' };
  if (!r.clos_par_acteur && r.clos_cause !== null) return { genre: 'automatique' };
  return { genre: 'ancien' };
}

/** La lecture des demandes (Quantitatif > Performance). Le calcul des durées : `src/stats/performance.ts`. */
export class PgPerformanceStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Les demandes COMMENCÉES sur la période, plus toutes celles encore ouvertes quelle que soit leur date (le drapeau
   * `dans_la_periode` les distingue), avec leur première et leur dernière réponse et leur fin, même postérieures à
   * la période : une demande appartient au jour où le client s'est mis à attendre.
   *
   * 🔴 `tenant_id = $1` sur le journal, sur la conversation et sur les deux collaborateurs relus ; les messages se
   * lisent par la conversation de la demande, déjà bornée à l'espace (la table n'a pas de `tenant_id`). Les
   * conversations de TEST sont exclues, comme dans toutes les statistiques.
   *
   * ⚠️ UNE OUVERTURE SE LIT SUR L'ÉVÉNEMENT QUI PRÉCÈDE (`lag`) : elle n'en est une que si rien n'était ouvert,
   * c'est-à-dire si l'événement pertinent d'avant est une fin, ou s'il n'y en a pas. Deux passages sans fin entre eux
   * sont UNE demande. Seuls comptent les événements d'ouverture et de fin, et seulement depuis le début de la mesure :
   * un passage d'avant n'a peut-être jamais eu sa fin datée.
   *
   * 🔴 LE DÉBUT N'EST PAS L'OUVERTURE (règle de Julien du 2026-09-29, `src/stats/performance.ts`) : l'ouverture si le
   * dernier message significatif (`MESSAGE_SIGNIFICATIF_SQL`) qui la précède est entrant, sinon le premier message
   * entrant entre l'ouverture et la fin. Sans lui, la demande n'a jamais commencé et n'est rendue nulle part.
   *
   * ⚠️ Une demande close avant la période, ou ouverte après elle, ne peut pas y commencer : elle est écartée AVANT
   * le calcul de son début, qui coûte deux lectures de messages. Les encore ouvertes, elles, sont toujours lues.
   */
  async lire(tenantId: string, range: DateRange): Promise<{ mesureDepuis: Date | null; demandes: DemandeBrute[] }> {
    // Aucune donnée d'espace ici : la date d'application d'une migration, la même pour tous.
    // `public.` : plusieurs schémas de cette base portent une table de ce nom.
    const depuis = await this.pool.query<{ applied_at: Date }>(
      'select applied_at from public.schema_migrations where name = $1',
      [MIGRATION_DES_DEMANDES],
    );
    const mesureDepuis = depuis.rows[0]?.applied_at ?? null;

    const res = await this.pool.query<LigneDemande>(
      `with ${BOUNDS_CTE},
       ev as (
         select e.id, e.conversation_id, e.type, e.at,
                lag(e.type) over (partition by e.conversation_id order by e.at, e.id) as precedent
           from conversation_evenements e
           join conversations c on c.id = e.conversation_id and c.tenant_id = $1
          where e.tenant_id = $1 and not c.is_test
            and (e.type = any($5::text[]) or e.type = any($6::text[]))
            and ($7::timestamptz is null or e.at >= $7::timestamptz)
       ),
       demandes as (
         select o.id, o.conversation_id, f.at as close_le, f.acteur_id, f.cause,
                case when (select m.direction
                             from conversation_messages m
                            where m.conversation_id = o.conversation_id and m.created_at <= o.at
                              and ${MESSAGE_SIGNIFICATIF_SQL}
                            order by m.created_at desc
                            limit 1) = 'in'
                     then o.at
                     else (select min(m.created_at)
                             from conversation_messages m
                            where m.conversation_id = o.conversation_id and ${ENTRANT_SQL}
                              and m.created_at > o.at and (f.at is null or m.created_at < f.at))
                end as debut_le
           from ev o
           cross join bounds b
           left join lateral (
             select fe.at, fe.acteur_id, fe.cause
               from conversation_evenements fe
              where fe.tenant_id = $1 and fe.conversation_id = o.conversation_id
                and fe.type = any($6::text[]) and (fe.at, fe.id) > (o.at, o.id)
              order by fe.at, fe.id
              limit 1
           ) f on true
          where o.type = any($5::text[])
            and (o.precedent is null or o.precedent = any($6::text[]))
            and (f.at is null or (f.at >= b.start_ts and o.at < b.end_ts))
       )
       select d.conversation_id, d.debut_le, to_char(d.debut_le at time zone $4, 'YYYY-MM-DD') as jour,
              (d.debut_le >= b.start_ts and d.debut_le < b.end_ts) as dans_la_periode,
              r.created_at as repondu_le, ur.id as repondant_id, coalesce(nullif(ur.name, ''), ur.email) as repondant_nom,
              (select max(m.created_at)
                 from conversation_messages m
                where m.conversation_id = d.conversation_id
                  and m.direction = 'out' and m.origin = 'humain'
                  and m.created_at >= d.debut_le and (d.close_le is null or m.created_at <= d.close_le)) as derniere_reponse_le,
              d.close_le, uf.id as clos_par_id, coalesce(nullif(uf.name, ''), uf.email) as clos_par_nom,
              (d.acteur_id is not null) as clos_par_acteur, d.cause as clos_cause
         from demandes d
         cross join bounds b
         left join lateral (
           select m.created_at, m.sender_user_id
             from conversation_messages m
            where m.conversation_id = d.conversation_id
              and m.direction = 'out' and m.origin = 'humain'
              and m.created_at >= d.debut_le and (d.close_le is null or m.created_at <= d.close_le)
            order by m.created_at
            limit 1
         ) r on true
         left join users ur on ur.id = r.sender_user_id and ur.tenant_id = $1
         left join users uf on uf.id = d.acteur_id and uf.tenant_id = $1
        where d.debut_le is not null
          and ((d.debut_le >= b.start_ts and d.debut_le < b.end_ts) or d.close_le is null)
        order by d.debut_le, d.id`,
      [tenantId, range.from, range.to, STATS_TZ, [...TYPES_OUVERTURE], [...TYPES_FIN], mesureDepuis],
    );

    return {
      mesureDepuis,
      demandes: res.rows.map((r) => ({
        conversationId: r.conversation_id,
        debutLe: r.debut_le,
        jour: r.jour,
        dansLaPeriode: r.dans_la_periode,
        reponduLe: r.repondu_le,
        repondant: repondantDe(r),
        derniereReponseLe: r.derniere_reponse_le,
        closeLe: r.close_le,
        closePar: closeParDe(r),
      })),
    };
  }
}
