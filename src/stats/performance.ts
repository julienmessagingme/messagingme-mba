import type { BusinessHours } from '../workflow/conditions';
import type { TypeEvenement } from '../inbox/evenements';
import type { DateRange } from './range';
import { horairesExploitables, mesureurDeTempsOuvre } from '../lib/heures-ouvrees';

/**
 * QUANTITATIF > PERFORMANCE : le temps de réponse et le temps de résolution de l'équipe (cadrage du 2026-09-29,
 * `docs/superpowers/specs/2026-09-29-kpi-reponse-resolution-design.md`).
 *
 * UNE DEMANDE S'OUVRE quand un robot passe la main à l'équipe : un scénario ou un agent IA (`escaladee`, migration
 * 0194, à chaque passage, drapeau d'escalade ou non), la réponse à une campagne dont le devenir est l'Inbox
 * (`escaladee` aussi), l'agent de Meta (`passee_par_mba`, 0192). Un collaborateur qui prend le fil lui-même en
 * écrivant n'en ouvre pas : personne n'attendait, et elle serait répondue en 0 s. Un nouveau passage pendant qu'une
 * demande est ouverte n'en ouvre pas une seconde : le client attend toujours la même réponse.
 *
 * 🔴 SON CHRONO PART QUAND LE CLIENT A ÉCRIT, PAS À L'OUVERTURE (décision de Julien du 2026-09-29). Son DÉBUT est
 * l'ouverture si, à cet instant, le dernier message significatif de la conversation est ENTRANT ; sinon, le premier
 * message entrant qui suit l'ouverture et précède la fin. Significatif : un message entrant, un modèle sortant, ou un
 * message sortant écrit par un collaborateur ; ceux d'un robot (scénario, agent IA, agent de Meta), modèles à part,
 * ne comptent pas, parce qu'un robot qui répond ne rend pas la balle au client. Sans message entrant, la demande n'a
 * jamais commencé : elle n'est comptée NULLE PART. Sans cette règle, une campagne « modèle puis passer à un humain »
 * ouvrait une demande par destinataire dès l'ENVOI, et celui qui répondait deux jours plus tard donnait deux jours de
 * temps de réponse. La période et le jour d'une demande se lisent sur son début.
 *
 * SA FIN : le premier `traitee`, `archivee`, `rendue_mba` ou `rendue_scenario` qui suit l'ouverture. Tout compte
 * comme résolu.
 * SA RÉPONSE : le premier message sortant d'origine `humain` (écrit dans l'Inbox, texte ou modèle) entre le début et
 * la fin. Ni l'API, ni un assistant MCP, ni une campagne, ni un robot.
 *
 * 🔴 LES DEMANDES SE CALCULENT À LA LECTURE, jamais stockées : la base rend des INSTANTS et des AUTEURS
 * (`PgPerformanceStore`), et les durées, qui dépendent des heures d'ouverture de l'espace, se calculent ici. Une
 * durée stockée deviendrait fausse le jour où l'espace change ses horaires.
 *
 * 🔴 UNE FIN AUTOMATIQUE APRÈS UNE RÉPONSE S'ARRÊTE À LA DERNIÈRE RÉPONSE (décision de Julien du 2026-09-29). Le
 * balayage ne rend jamais un fil dont l'escalade attend encore sa première réponse ; c'est cette réponse qui efface
 * la marque, et le balayage rend ensuite le fil au robot au bout du délai de reprise de l'espace (deux heures par
 * défaut) compté depuis la DERNIÈRE réponse d'un collaborateur, faute de « Traité ». Compter la résolution jusqu'à
 * cette remise mesurerait le minuteur, pas l'équipe : une demande close par un geste automatique (`closePar.genre ===
 * 'automatique'`) et qui a eu au moins une réponse se résout donc à sa dernière réponse avant la fin. Elle reste
 * « résolue ». Les fins par un collaborateur ne changent pas.
 *
 * ⚠️ « RÉSOLUES SANS RÉPONSE » EST UNE CATÉGORIE À PART, ET ELLE N'ENTRE PAS DANS LE TEMPS DE RÉSOLUTION : une demande
 * close sans qu'aucun collaborateur ait répondu (archivée, marquée Traité, reprise par un scénario, ou rendue par le
 * balayage quand le passage n'a pas posé de marque d'escalade) n'a pas de travail de l'équipe à mesurer.
 *
 * ⚠️ « ENCORE OUVERTES » PORTE SUR TOUTES LES DEMANDES OUVERTES EN CE MOMENT, depuis le début de la mesure et quelle
 * que soit la période, tout comme la plus ancienne : une demande de 31 jours toujours ouverte ne doit pas disparaître
 * d'une vue de 30. Les autres compteurs sont ceux de la période, et ses demandes se partagent entre résolues,
 * résolues sans réponse et celles qui restent ouvertes.
 */

/** Ce qui ouvre une demande. */
export const TYPES_OUVERTURE = ['escaladee', 'passee_par_mba'] as const satisfies readonly TypeEvenement[];
/** Ce qui la ferme, le premier qui suit l'ouverture. */
export const TYPES_FIN = ['traitee', 'archivee', 'rendue_mba', 'rendue_scenario'] as const satisfies readonly TypeEvenement[];

/**
 * Qui a répondu, ou qui a clos : un collaborateur de l'espace, un geste sans auteur connu, dit « automatique »
 * (l'événement porte une cause : délai de reprise écoulé, scénario qui reprend la conversation, y compris lancé depuis
 * l'Inbox, appel d'API), ou un collaborateur supprimé depuis (un acteur nul SANS cause, la règle du journal,
 * `src/inbox/evenements.ts`). Le confondre avec « automatique » attribuerait à une machine le travail d'une personne
 * partie.
 */
export type Qui =
  | { genre: 'collaborateur'; userId: string; nom: string }
  | { genre: 'automatique' }
  | { genre: 'ancien' };

/**
 * Une demande COMMENCÉE (le client attend) telle que la base la rend : des instants et des auteurs, aucune durée.
 * Une demande ouverte que le client n'a jamais fait commencer n'est jamais rendue.
 */
export interface DemandeBrute {
  conversationId: string;
  /** Le début : l'instant où le client s'est mis à attendre (en-tête de ce fichier), pas l'ouverture. */
  debutLe: Date;
  /** Le jour civil du début (`YYYY-MM-DD`), dans le fuseau des statistiques, celui de la période. */
  jour: string;
  /**
   * Le début tombe-t-il dans la période demandée ? La base rend AUSSI, hors période, les demandes encore ouvertes,
   * qui ne comptent que dans « encore ouvertes » et la plus ancienne.
   */
  dansLaPeriode: boolean;
  /** La première réponse d'un collaborateur, `null` = aucune. */
  reponduLe: Date | null;
  /** Son auteur ; `null` seulement quand il n'y a pas de réponse. */
  repondant: Qui | null;
  /** La DERNIÈRE réponse d'un collaborateur avant la fin (la première s'il n'y en a qu'une), `null` = aucune. */
  derniereReponseLe: Date | null;
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
  /** Les demandes commencées ce jour-là. */
  demandes: number;
  reponseMediane: number | null;
  resolutionMediane: number | null;
}

export interface LigneCollaborateur {
  qui: Qui;
  /** Les demandes dont il a donné la PREMIÈRE réponse. */
  reponses: number;
  reponseMediane: number | null;
  /**
   * TOUTES les demandes de la période qu'il a closes (Traité, archivée, rendue à la main), avec ou sans réponse.
   * Pas le nombre de mesures derrière `resolutionMediane`, qui ne porte que sur celles qui ont eu une réponse.
   */
  closes: number;
  /** La médiane de résolution des demandes qu'il a closes APRÈS au moins une réponse ; `null` = aucune. */
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
  /** Les demandes COMMENCÉES sur la période (le client s'est mis à attendre). */
  demandes: number;
  /** Celles de la période closes après au moins une réponse. */
  resolues: number;
  /** Celles de la période closes sans qu'aucun collaborateur ait répondu : à part, et hors du temps de résolution. */
  resoluesSansReponse: number;
  /**
   * TOUTES les demandes encore ouvertes en ce moment, depuis le début de la mesure, QUELLE QUE SOIT LA PÉRIODE : une
   * demande commencée avant la période et toujours ouverte y est. Pas un sous-total de `demandes`.
   */
  ouvertes: number;
  /** Le début de la plus ancienne demande encore ouverte, toutes périodes, ISO ; `null` = aucune. */
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
  const parQui = new Map<string, { qui: Qui; reponses: number[]; closes: number; resolutions: number[] }>();
  const ligneDe = (q: Qui) => {
    const cle = cleDe(q);
    let l = parQui.get(cle);
    if (!l) { l = { qui: q, reponses: [], closes: 0, resolutions: [] }; parQui.set(cle, l); }
    return l;
  };

  let dePeriode = 0;
  let resolues = 0;
  let resoluesSansReponse = 0;
  let ouvertes = 0;
  let plusAncienne: Date | null = null;

  for (const d of demandes) {
    // « Encore ouvertes » et la plus ancienne : toutes les demandes ouvertes en ce moment, période ou non.
    if (d.closeLe === null) {
      ouvertes += 1;
      if (plusAncienne === null || d.debutLe < plusAncienne) plusAncienne = d.debutLe;
    }
    // Tout le reste ne porte que sur les demandes commencées dans la période.
    if (!d.dansLaPeriode) continue;
    dePeriode += 1;

    let j = parJour.get(d.jour);
    if (!j) { j = { demandes: 0, reponses: [], resolutions: [] }; parJour.set(d.jour, j); }
    j.demandes += 1;

    if (d.reponduLe !== null && d.repondant !== null) {
      const t = mesurer(d.debutLe, d.reponduLe);
      reponses.push(t);
      j.reponses.push(t);
      ligneDe(d.repondant).reponses.push(t);
    }

    if (d.closeLe === null) continue;
    // Qui a clos compte TOUTES ses clôtures, avec ou sans réponse ; seule la médiane exige une réponse.
    if (d.closePar !== null) ligneDe(d.closePar).closes += 1;
    if (d.reponduLe === null) {
      resoluesSansReponse += 1;
      continue;
    }
    resolues += 1;
    // Une fin automatique mesurerait le délai de reprise, pas l'équipe : la résolution s'arrête alors à la
    // dernière réponse d'un collaborateur (en-tête de ce fichier).
    const fin = d.closePar?.genre === 'automatique' && d.derniereReponseLe !== null ? d.derniereReponseLe : d.closeLe;
    const t = mesurer(d.debutLe, fin);
    resolutions.push(t);
    j.resolutions.push(t);
    if (d.closePar !== null) ligneDe(d.closePar).resolutions.push(t);
  }

  return {
    mesureDepuis: ctx.mesureDepuis?.toISOString() ?? null,
    mode,
    fuseau: ctx.fuseau,
    reponse: centiles(reponses),
    resolution: centiles(resolutions),
    demandes: dePeriode,
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
        closes: l.closes,
        resolutionMediane: centile(l.resolutions, 0.5),
      })),
  };
}

/**
 * Ce dont la lecture a besoin : les demandes brutes commencées dans la période ET celles encore ouvertes, quelle que
 * soit leur date (`dansLaPeriode` les distingue), et les horaires de l'espace.
 */
export interface DepsPerformance {
  demandes(tenantId: string, range: DateRange): Promise<{ mesureDepuis: Date | null; demandes: DemandeBrute[] }>;
  reglages(tenantId: string): Promise<{ timezone: string; businessHours: BusinessHours | null }>;
}

/** Les indicateurs d'un espace sur une période : la lecture de la base, puis le calcul. */
export async function lirePerformance(deps: DepsPerformance, tenantId: string, range: DateRange): Promise<Performance> {
  const [{ mesureDepuis, demandes }, reglages] = await Promise.all([deps.demandes(tenantId, range), deps.reglages(tenantId)]);
  return calculerPerformance(demandes, { fuseau: reglages.timezone, horaires: reglages.businessHours, mesureDepuis });
}
