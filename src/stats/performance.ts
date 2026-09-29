import type { BusinessHours } from '../workflow/conditions';
import type { TypeEvenement } from '../inbox/evenements';
import type { DateRange } from './range';
import { horairesExploitables, mesureurDeTempsOuvre } from '../lib/heures-ouvrees';

/**
 * QUANTITATIF > PERFORMANCE : le temps de réponse et le temps de résolution de l'équipe (cadrage du 2026-09-29,
 * `docs/superpowers/specs/2026-09-29-kpi-reponse-resolution-design.md`).
 *
 * UNE DEMANDE, c'est un robot qui passe la main à l'équipe : un scénario ou un agent IA (`escaladee`, migration
 * 0194), l'agent de Meta (`passee_par_mba`, 0192). Un collaborateur qui prend le fil lui-même en écrivant n'en ouvre
 * pas : personne n'attendait, et elle serait répondue en 0 s. Un nouveau passage pendant qu'une demande est ouverte
 * n'en ouvre pas une seconde : le client attend toujours la même réponse.
 *
 * SA FIN : le premier `traitee`, `archivee`, `rendue_mba` ou `rendue_scenario` qui suit. Tout compte comme résolu.
 * SA RÉPONSE : le premier message sortant d'origine `humain` (écrit dans l'Inbox, texte ou modèle) entre l'ouverture
 * et la fin. Ni l'API, ni un assistant MCP, ni une campagne, ni un robot.
 *
 * 🔴 LES DEMANDES SE CALCULENT À LA LECTURE, jamais stockées : la base rend des INSTANTS et des AUTEURS
 * (`PgPerformanceStore`), et les durées, qui dépendent des heures d'ouverture de l'espace, se calculent ici. Une
 * durée stockée deviendrait fausse le jour où l'espace change ses horaires.
 *
 * ⚠️ « RÉSOLUES SANS RÉPONSE » EST UNE CATÉGORIE À PART, ET ELLE N'ENTRE PAS DANS LE TEMPS DE RÉSOLUTION. Une demande
 * que personne n'a répondue et que le balayage a rendue au scénario au bout de deux heures n'est pas un travail de
 * l'équipe : la compter tirerait la médiane de résolution vers le délai du balayage, qui ne mesure rien de l'équipe.
 * Les compteurs forment donc une partition : demandes = résolues + résolues sans réponse + encore ouvertes.
 */

/** Ce qui ouvre une demande. */
export const TYPES_OUVERTURE = ['escaladee', 'passee_par_mba'] as const satisfies readonly TypeEvenement[];
/** Ce qui la ferme, le premier qui suit l'ouverture. */
export const TYPES_FIN = ['traitee', 'archivee', 'rendue_mba', 'rendue_scenario'] as const satisfies readonly TypeEvenement[];

/**
 * Qui a répondu, ou qui a clos : un collaborateur de l'espace, un geste AUTOMATIQUE (l'événement porte une cause :
 * balayage, scénario qui reprend, clé d'API), ou un collaborateur supprimé depuis (un acteur nul SANS cause, la règle
 * du journal, `src/inbox/evenements.ts`). Le confondre avec « automatique » attribuerait à une machine le travail
 * d'une personne partie.
 */
export type Qui =
  | { genre: 'collaborateur'; userId: string; nom: string }
  | { genre: 'automatique' }
  | { genre: 'ancien' };

/** Une demande telle que la base la rend : des instants et des auteurs, aucune durée. */
export interface DemandeBrute {
  conversationId: string;
  ouverteLe: Date;
  /** Le jour civil de l'ouverture (`YYYY-MM-DD`), dans le fuseau des statistiques, celui de la période. */
  jour: string;
  /** La première réponse d'un collaborateur, `null` = aucune. */
  reponduLe: Date | null;
  /** Son auteur ; `null` seulement quand il n'y a pas de réponse. */
  repondant: Qui | null;
  /** La fin, `null` = encore ouverte. */
  closeLe: Date | null;
  /** Qui l'a close ; `null` seulement quand elle est encore ouverte. */
  closePar: Qui | null;
}

/** Une médiane et un 90e centile, en millisecondes ; `null` = aucune mesure, que l'écran dit « non disponible ». */
export interface Centiles {
  mediane: number | null;
  p90: number | null;
  /** Le nombre de mesures derrière ces deux chiffres. */
  n: number;
}

export interface JourPerformance {
  jour: string;
  /** Les demandes ouvertes ce jour-là. */
  demandes: number;
  reponseMediane: number | null;
  resolutionMediane: number | null;
}

export interface LigneCollaborateur {
  qui: Qui;
  /** Les demandes dont il a donné la PREMIÈRE réponse. */
  reponses: number;
  reponseMediane: number | null;
  /** Les demandes résolues (avec réponse) qu'il a closes. */
  closes: number;
  resolutionMediane: number | null;
}

export interface Performance {
  /**
   * Depuis quand le journal date les passages (l'application de la migration 0194), ISO ; `null` = inconnu. Aucune
   * demande antérieure n'est comptée : leur fin n'était pas toujours datée.
   */
  mesureDepuis: string | null;
  /** `ouvre` : durées en heures d'ouverture de l'espace ; `brut` : il n'en a aucune d'exploitable, et l'écran le dit. */
  mode: 'ouvre' | 'brut';
  fuseau: string;
  reponse: Centiles;
  resolution: Centiles;
  /** Les demandes ouvertes sur la période. */
  demandes: number;
  /** Closes après au moins une réponse. */
  resolues: number;
  /** Closes sans qu'aucun collaborateur ait répondu : à part, et hors du temps de résolution. */
  resoluesSansReponse: number;
  /** Pas encore closes. */
  ouvertes: number;
  /** L'ouverture de la plus ancienne encore ouverte, ISO ; `null` = aucune. */
  plusAncienneOuverte: string | null;
  /** Une ligne par jour qui a au moins une demande ; l'écran pose lui-même l'axe de la période. */
  parJour: JourPerformance[];
  parCollaborateur: LigneCollaborateur[];
}

/**
 * Le centile `p` (0 à 1) de valeurs, par interpolation linéaire entre les deux rangs voisins (la définition de
 * `percentile_cont` de Postgres), arrondi à la milliseconde. `null` sans valeur : une médiane de rien n'est pas 0.
 */
export function centile(valeurs: readonly number[], p: number): number | null {
  if (valeurs.length === 0) return null;
  const tries = [...valeurs].sort((a, b) => a - b);
  const pos = (tries.length - 1) * p;
  const bas = Math.floor(pos);
  const haut = Math.ceil(pos);
  return Math.round(tries[bas]! + (tries[haut]! - tries[bas]!) * (pos - bas));
}

const centiles = (valeurs: readonly number[]): Centiles => ({ mediane: centile(valeurs, 0.5), p90: centile(valeurs, 0.9), n: valeurs.length });

/** La clé d'une ligne du tableau par collaborateur. */
function cleDe(q: Qui): string {
  return q.genre === 'collaborateur' ? `u:${q.userId}` : q.genre;
}

/** Les collaborateurs par nom, puis les anciens, puis l'automatique : ce qu'un responsable cherche d'abord. */
function rang(q: Qui): number {
  return q.genre === 'collaborateur' ? 0 : q.genre === 'ancien' ? 1 : 2;
}

/**
 * Les indicateurs d'une période, à partir des demandes brutes. Pure : le fuseau et les horaires sont ceux de
 * l'espace, `mesureDepuis` vient de la base.
 */
export function calculerPerformance(
  demandes: readonly DemandeBrute[],
  ctx: { fuseau: string; horaires: BusinessHours | null; mesureDepuis: Date | null },
): Performance {
  const mode = horairesExploitables(ctx.fuseau, ctx.horaires) ? 'ouvre' : 'brut';
  const mesurer = mesureurDeTempsOuvre(ctx.fuseau, ctx.horaires);

  const reponses: number[] = [];
  const resolutions: number[] = [];
  const parJour = new Map<string, { demandes: number; reponses: number[]; resolutions: number[] }>();
  const parQui = new Map<string, { qui: Qui; reponses: number[]; resolutions: number[] }>();
  const ligneDe = (q: Qui) => {
    const cle = cleDe(q);
    let l = parQui.get(cle);
    if (!l) { l = { qui: q, reponses: [], resolutions: [] }; parQui.set(cle, l); }
    return l;
  };

  let resolues = 0;
  let resoluesSansReponse = 0;
  let ouvertes = 0;
  let plusAncienne: Date | null = null;

  for (const d of demandes) {
    let j = parJour.get(d.jour);
    if (!j) { j = { demandes: 0, reponses: [], resolutions: [] }; parJour.set(d.jour, j); }
    j.demandes += 1;

    if (d.reponduLe !== null && d.repondant !== null) {
      const t = mesurer(d.ouverteLe, d.reponduLe);
      reponses.push(t);
      j.reponses.push(t);
      ligneDe(d.repondant).reponses.push(t);
    }

    if (d.closeLe === null) {
      ouvertes += 1;
      if (plusAncienne === null || d.ouverteLe < plusAncienne) plusAncienne = d.ouverteLe;
    } else if (d.reponduLe === null) {
      resoluesSansReponse += 1;
    } else {
      resolues += 1;
      const t = mesurer(d.ouverteLe, d.closeLe);
      resolutions.push(t);
      j.resolutions.push(t);
      if (d.closePar !== null) ligneDe(d.closePar).resolutions.push(t);
    }
  }

  return {
    mesureDepuis: ctx.mesureDepuis?.toISOString() ?? null,
    mode,
    fuseau: ctx.fuseau,
    reponse: centiles(reponses),
    resolution: centiles(resolutions),
    demandes: demandes.length,
    resolues,
    resoluesSansReponse,
    ouvertes,
    plusAncienneOuverte: plusAncienne?.toISOString() ?? null,
    parJour: [...parJour.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([jour, v]) => ({
        jour, demandes: v.demandes, reponseMediane: centile(v.reponses, 0.5), resolutionMediane: centile(v.resolutions, 0.5),
      })),
    parCollaborateur: [...parQui.values()]
      .sort((a, b) => rang(a.qui) - rang(b.qui)
        || (a.qui.genre === 'collaborateur' && b.qui.genre === 'collaborateur' ? a.qui.nom.localeCompare(b.qui.nom, 'fr') : 0))
      .map((l) => ({
        qui: l.qui,
        reponses: l.reponses.length,
        reponseMediane: centile(l.reponses, 0.5),
        closes: l.resolutions.length,
        resolutionMediane: centile(l.resolutions, 0.5),
      })),
  };
}

/** Ce dont la lecture a besoin : les demandes brutes de la période, et les horaires de l'espace. */
export interface DepsPerformance {
  demandes(tenantId: string, range: DateRange): Promise<{ mesureDepuis: Date | null; demandes: DemandeBrute[] }>;
  reglages(tenantId: string): Promise<{ timezone: string; businessHours: BusinessHours | null }>;
}

/** Les indicateurs d'un espace sur une période : la lecture de la base, puis le calcul. */
export async function lirePerformance(deps: DepsPerformance, tenantId: string, range: DateRange): Promise<Performance> {
  const [{ mesureDepuis, demandes }, reglages] = await Promise.all([deps.demandes(tenantId, range), deps.reglages(tenantId)]);
  return calculerPerformance(demandes, { fuseau: reglages.timezone, horaires: reglages.businessHours, mesureDepuis });
}
