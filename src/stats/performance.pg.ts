import type { Pool } from 'pg';
import { BOUNDS_CTE, STATS_TZ, type DateRange } from './range';
import { TYPES_FIN, TYPES_OUVERTURE, type DemandeBrute, type Qui } from './performance';

/**
 * La migration qui a ouvert la mesure : avant elle, le journal ne datait ni le passage d'un scénario ou d'un agent
 * IA à l'équipe, ni le retour au scénario. Sa date d'application dans `schema_migrations` est le « mesuré depuis »
 * de l'écran, et la borne basse de toute demande. `tests/migration-0194.test.ts` vérifie que le fichier porte ce nom.
 */
export const MIGRATION_DES_DEMANDES = '0194_evenements_demandes.sql';

interface LigneDemande {
  conversation_id: string;
  ouverte_le: Date;
  jour: string;
  repondu_le: Date | null;
  repondant_id: string | null;
  repondant_nom: string | null;
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
 * retrouve plus, ou nul SANS cause, est un collaborateur supprimé depuis ; nul AVEC une cause est un geste
 * automatique (balayage, scénario qui reprend, clé d'API).
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
   * Les demandes OUVERTES sur la période (et depuis le début de la mesure), avec leur première réponse et leur fin,
   * même postérieures à la période : une demande appartient au jour où le client s'est mis à attendre.
   *
   * 🔴 `tenant_id = $1` sur le journal, sur la conversation et sur les deux collaborateurs relus ; les messages se
   * lisent par la conversation de la demande, déjà bornée à l'espace (la table n'a pas de `tenant_id`). Les
   * conversations de TEST sont exclues, comme dans toutes les statistiques.
   *
   * ⚠️ LE DÉBUT D'UNE DEMANDE SE LIT SUR L'ÉVÉNEMENT QUI PRÉCÈDE (`lag`) : une ouverture n'en est une que si rien
   * n'était ouvert, c'est-à-dire si l'événement pertinent d'avant est une fin, ou s'il n'y en a pas. Deux passages
   * sans fin entre eux sont UNE demande, datée du premier. Seuls comptent les événements d'ouverture et de fin, et
   * seulement depuis le début de la mesure : un passage d'avant n'a peut-être jamais eu sa fin datée.
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
            and e.at < (select end_ts from bounds)
       ),
       ouvertures as (
         select ev.id, ev.conversation_id, ev.at
           from ev, bounds b
          where ev.type = any($5::text[])
            and (ev.precedent is null or ev.precedent = any($6::text[]))
            and ev.at >= b.start_ts
       )
       select o.conversation_id, o.at as ouverte_le, to_char(o.at at time zone $4, 'YYYY-MM-DD') as jour,
              r.created_at as repondu_le, ur.id as repondant_id, coalesce(nullif(ur.name, ''), ur.email) as repondant_nom,
              f.at as close_le, uf.id as clos_par_id, coalesce(nullif(uf.name, ''), uf.email) as clos_par_nom,
              (f.acteur_id is not null) as clos_par_acteur, f.cause as clos_cause
         from ouvertures o
         left join lateral (
           select fe.at, fe.acteur_id, fe.cause
             from conversation_evenements fe
            where fe.tenant_id = $1 and fe.conversation_id = o.conversation_id
              and fe.type = any($6::text[]) and (fe.at, fe.id) > (o.at, o.id)
            order by fe.at, fe.id
            limit 1
         ) f on true
         left join lateral (
           select m.created_at, m.sender_user_id
             from conversation_messages m
            where m.conversation_id = o.conversation_id
              and m.direction = 'out' and m.origin = 'humain'
              and m.created_at >= o.at and (f.at is null or m.created_at <= f.at)
            order by m.created_at
            limit 1
         ) r on true
         left join users ur on ur.id = r.sender_user_id and ur.tenant_id = $1
         left join users uf on uf.id = f.acteur_id and uf.tenant_id = $1
        order by o.at, o.id`,
      [tenantId, range.from, range.to, STATS_TZ, [...TYPES_OUVERTURE], [...TYPES_FIN], mesureDepuis],
    );

    return {
      mesureDepuis,
      demandes: res.rows.map((r) => ({
        conversationId: r.conversation_id,
        ouverteLe: r.ouverte_le,
        jour: r.jour,
        reponduLe: r.repondu_le,
        repondant: repondantDe(r),
        closeLe: r.close_le,
        closePar: closeParDe(r),
      })),
    };
  }
}
