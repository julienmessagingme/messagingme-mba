/**
 * QUANTITATIF > PERFORMANCE (cadrage du 2026-09-29) : la forme de ce que rend
 * `GET /tenants/:tenantId/stats/performance`, sa validation, et l'écriture d'une durée.
 *
 * Miroir de `src/stats/performance.ts` (le serveur), que la console ne peut pas importer. Fonctions pures, testées
 * dans `performance.test.ts`. Toutes les durées sont en millisecondes, et `null` veut dire « on ne sait pas » :
 * l'écran l'écrit « non disponible », jamais 0, qui affirmerait une équipe instantanée.
 */
import type { Locale } from './locale';

export type Qui =
  | { genre: 'collaborateur'; userId: string; nom: string }
  | { genre: 'automatique' }
  | { genre: 'ancien' };

export interface Centiles {
  mediane: number | null;
  p90: number | null;
  n: number;
}

export interface JourPerformance {
  jour: string;
  demandes: number;
  reponseMediane: number | null;
  resolutionMediane: number | null;
}

export interface LigneCollaborateur {
  qui: Qui;
  reponses: number;
  reponseMediane: number | null;
  /** TOUTES les demandes qu'il a closes, avec ou sans réponse ; la médiane ne porte que sur celles avec réponse. */
  closes: number;
  resolutionMediane: number | null;
}

/** La forme est tenue par `tests/web-performance-parite.test.ts` : un champ renommé d'un seul côté le casse. */
export interface Performance {
  mesureDepuis: string | null;
  /** `ouvre` : en heures d'ouverture de l'espace ; `brut` : il n'en a aucune, l'écran le dit. */
  mode: 'ouvre' | 'brut';
  fuseau: string;
  reponse: Centiles;
  resolution: Centiles;
  /** Les demandes commencées sur la période. */
  demandes: number;
  resolues: number;
  resoluesSansReponse: number;
  /** TOUTES les demandes ouvertes en ce moment, quelle que soit la période : pas un sous-total de `demandes`. */
  ouvertes: number;
  /** Le début de la plus ancienne encore ouverte, toutes périodes. */
  plusAncienneOuverte: string | null;
  parJour: JourPerformance[];
  parCollaborateur: LigneCollaborateur[];
}

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const entier = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
/** Une durée ou `null`. `undefined` = mal formé (un nombre négatif, une chaîne). */
const duree = (v: unknown): number | null | undefined => (v === null ? null : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const texteOuNul = (v: unknown): v is string | null => v === null || typeof v === 'string';

function lireCentiles(v: unknown): Centiles | null {
  if (!estObjet(v) || !entier(v.n)) return null;
  const mediane = duree(v.mediane);
  const p90 = duree(v.p90);
  if (mediane === undefined || p90 === undefined) return null;
  return { mediane, p90, n: v.n };
}

function lireQui(v: unknown): Qui | null {
  if (!estObjet(v)) return null;
  if (v.genre === 'automatique' || v.genre === 'ancien') return { genre: v.genre };
  if (v.genre === 'collaborateur' && typeof v.userId === 'string' && typeof v.nom === 'string') {
    return { genre: 'collaborateur', userId: v.userId, nom: v.nom };
  }
  return null;
}

function lireJour(v: unknown): JourPerformance | null {
  if (!estObjet(v) || typeof v.jour !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.jour) || !entier(v.demandes)) return null;
  const reponseMediane = duree(v.reponseMediane);
  const resolutionMediane = duree(v.resolutionMediane);
  if (reponseMediane === undefined || resolutionMediane === undefined) return null;
  return { jour: v.jour, demandes: v.demandes, reponseMediane, resolutionMediane };
}

function lireLigne(v: unknown): LigneCollaborateur | null {
  if (!estObjet(v) || !entier(v.reponses) || !entier(v.closes)) return null;
  const qui = lireQui(v.qui);
  const reponseMediane = duree(v.reponseMediane);
  const resolutionMediane = duree(v.resolutionMediane);
  if (qui === null || reponseMediane === undefined || resolutionMediane === undefined) return null;
  return { qui, reponses: v.reponses, reponseMediane, closes: v.closes, resolutionMediane };
}

/**
 * La réponse du serveur, VÉRIFIÉE et non castée : elle vient du réseau, et l'écran fait `.map` dessus pendant le
 * rendu. `null` quand la forme générale n'y est pas (une API d'une autre version, un proxy) : l'écran le dit au
 * lieu d'afficher des zéros. Une ligne mal formée d'un tableau est écartée seule.
 */
export function lirePerformance(brut: unknown): Performance | null {
  if (!estObjet(brut)) return null;
  const reponse = lireCentiles(brut.reponse);
  const resolution = lireCentiles(brut.resolution);
  if (reponse === null || resolution === null) return null;
  if (brut.mode !== 'ouvre' && brut.mode !== 'brut') return null;
  if (typeof brut.fuseau !== 'string' || !texteOuNul(brut.mesureDepuis) || !texteOuNul(brut.plusAncienneOuverte)) return null;
  if (!entier(brut.demandes) || !entier(brut.resolues) || !entier(brut.resoluesSansReponse) || !entier(brut.ouvertes)) return null;
  if (!Array.isArray(brut.parJour) || !Array.isArray(brut.parCollaborateur)) return null;
  return {
    mesureDepuis: brut.mesureDepuis,
    mode: brut.mode,
    fuseau: brut.fuseau,
    reponse,
    resolution,
    demandes: brut.demandes,
    resolues: brut.resolues,
    resoluesSansReponse: brut.resoluesSansReponse,
    ouvertes: brut.ouvertes,
    plusAncienneOuverte: brut.plusAncienneOuverte,
    parJour: brut.parJour.map(lireJour).filter((j): j is JourPerformance => j !== null),
    parCollaborateur: brut.parCollaborateur.map(lireLigne).filter((l): l is LigneCollaborateur => l !== null),
  };
}

const MIN = 60_000;
const H = 60 * MIN;

/**
 * Une durée lisible : « 45 s », « 12 min », « 1 h 05 », « 2 j 3 h ». Arrondie à l'unité affichée (la seconde sous
 * la minute, la minute sous le jour, l'heure au-delà) : un temps de réponse ne se lit pas à la seconde près quand il
 * se compte en heures. Chaque palier se décide sur la valeur ARRONDIE, sinon 59,6 s s'écrirait « 60 s ».
 * `null` : « non disponible », jamais « 0 ».
 *
 * 🔴 EN HEURES D'OUVERTURE (`mode: 'ouvre'`), JAMAIS DE JOURS : des heures et des minutes (« 45 h 12 »). Un « jour »
 * y vaudrait 24 heures OUVRÉES, soit trois jours de bureau : « 1 j 21 h » se lirait « presque deux jours » pour 45 h
 * ouvrées. `mode` est requis pour qu'aucun appelant ne l'oublie.
 */
export function fmtDuree(ms: number | null, locale: Locale, mode: Performance['mode']): string {
  const en = locale === 'en';
  if (ms === null) return en ? 'not available' : 'non disponible';
  const secondes = Math.round(ms / 1000);
  if (secondes < 60) return `${secondes} s`;
  const minutes = Math.round(ms / MIN);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60 || mode === 'ouvre') {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
  }
  const heures = Math.round(ms / H);
  const j = Math.floor(heures / 24);
  const h = heures % 24;
  const jours = en ? `${j} d` : `${j} j`;
  return h === 0 ? jours : `${jours} ${h} h`;
}

/** Le nom d'une ligne du tableau par collaborateur. */
export function nomDeQui(q: Qui, t: (fr: string, en?: string) => string): string {
  if (q.genre === 'collaborateur') return q.nom;
  if (q.genre === 'ancien') return t('Ancien collaborateur', 'Former teammate');
  return t('Automatique', 'Automatic');
}
