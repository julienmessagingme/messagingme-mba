import type { WorkerHeartbeatRow } from './heartbeat-store.pg';
import type { LatenceHttpRow } from './latence-http';
import type { QueueLatenceRow, QueueLoadRow } from './store.pg';

/**
 * L'ONGLET SANTÉ DE /OPS (refonte, lot 1 : `docs/superpowers/specs/2026-10-27-ops-refonte-design.md`). Une pastille
 * par brique, verte, orange ou rouge, à partir des mesures qui existent déjà, et la jauge de capacité : la marge avant
 * de devoir grossir, sur le PIRE des signaux de capacité. Pur : la route lit, cette fonction juge, l'écran met en
 * mots (il porte la langue).
 */

export type EtatBrique = 'vert' | 'orange' | 'rouge';

/** Les seuils par défaut, tirés des bancs du 2026-10-27 ; réglables dans `/ops` au lot 4. */
export const SEUILS_SANTE = {
  /** Retard des accusés de Meta, p95 de la dernière heure ou âge du plus vieux en attente, en secondes. */
  accuses: { orange: 60, rouge: 120 },
  /** Retard des messages entrants, mêmes mesures. */
  entrants: { orange: 5, rouge: 30 },
  /** Connexions de la base, en pourcentage de ce qu'elle accepte. */
  connexions: { orange: 70, rouge: 85 },
  /** Part des réponses 5xx de l'API sur la dernière heure, en pourcentage, jugée à partir de `EFFECTIF_MIN_API` requêtes. */
  erreurs: { orange: 1, rouge: 5 },
  /** Âge du dernier battement d'un worker, en secondes. */
  battement: { orange: 120, rouge: 300 },
} as const;

type Seuil = { orange: number; rouge: number };

/**
 * En dessous, la part d'erreurs ne se juge pas : deux requêtes dont une en échec feraient 50 %. Le même effectif que la
 * carte de latence HTTP de l'écran (`EFFECTIF_MIN`, `web/lib/latence-http.ts`).
 */
export const EFFECTIF_MIN_API = 20;

/**
 * Les routes qui ne disent rien de la santé du service : la sonde de vie de Scaleway (toutes les 10 s, elle diluerait
 * les vraies erreurs) et `/ops` lui-même (sa carte Vercel rend un 502 quand Vercel est illisible).
 */
function routeDuService(route: string): boolean {
  return route !== '/live' && route !== '/ops' && !route.startsWith('/ops/');
}

export type CleBrique = 'api' | 'workers' | 'base' | 'entrants' | 'accuses';

export interface Brique {
  cle: CleBrique;
  etat: EtatBrique;
  /** La valeur jugée, dans l'unité de son seuil ; `null` = rien à mesurer (aucun trafic, ou trop peu pour l'API), donc vert. */
  mesure: number | null;
  /**
   * La lecture a échoué : la brique est orange, jamais verte. Sous saturation, ce sont justement ces lectures qui
   * tombent : un vert « aucun trafic » à ce moment-là mentirait.
   */
  indisponible?: true;
  /** Pour les workers : le rôle le plus en retard. */
  detail?: string;
}

/** Chaque entrée vaut `null` quand sa lecture a échoué. */
export interface EntreesSante {
  workers: WorkerHeartbeatRow[] | null;
  /** La latence des files sur le dernier quart d'heure (`getQueueLatence`). */
  latencesFiles: QueueLatenceRow[] | null;
  /** La charge des files à l'instant (`getQueueLoad`). */
  chargeFiles: QueueLoadRow[] | null;
  /** Les latences HTTP de la dernière heure. */
  latencesHttp: LatenceHttpRow[] | null;
  connexions: { utilisees: number; max: number } | null;
}

export interface Jauge {
  /** De 0 (un seuil rouge est atteint) à 100 (rien ne tire). */
  margePourcent: number;
  /** Le signal le plus tendu. */
  signal: Exclude<CleBrique, 'api' | 'workers'>;
  /** Une des lectures de capacité a échoué : la marge ne compte que les autres. */
  partielle: boolean;
}

export interface BilanSante {
  briques: Brique[];
  jauge: Jauge;
}

const FILE_ENTRANTS = 'webhook';
const FILE_ACCUSES = 'webhook-status';

function etat(mesure: number | null, seuil: Seuil): EtatBrique {
  if (mesure === null) return 'vert';
  if (mesure >= seuil.rouge) return 'rouge';
  if (mesure >= seuil.orange) return 'orange';
  return 'vert';
}

const INDISPONIBLE = { mesure: null, etat: 'orange', indisponible: true } as const;

/**
 * Le retard d'une file : le pire du p95 du quart d'heure et de l'âge du plus vieux en attente (une file figée se voit
 * tout de suite). Appelée seulement quand les deux lectures ont réussi.
 */
function retardFile(latences: QueueLatenceRow[], charge: QueueLoadRow[], file: string): number | null {
  const p95 = latences.find((l) => l.queue === file && l.echantillons > 0)?.boutEnBoutP95Secondes;
  const age = charge.find((c) => c.queue === file)?.ageMaxSecondes;
  const valeurs = [p95, age].filter((v): v is number => typeof v === 'number' && v > 0);
  return valeurs.length === 0 ? null : Math.max(...valeurs);
}

function partErreurs(lignes: LatenceHttpRow[]): number | null {
  const service = lignes.filter((l) => routeDuService(l.route));
  const total = service.reduce((s, l) => s + l.requetes, 0);
  if (total < EFFECTIF_MIN_API) return null;
  const erreurs = service.filter((l) => l.code >= 500).reduce((s, l) => s + l.requetes, 0);
  return (100 * erreurs) / total;
}

export function evaluerSante(e: EntreesSante): BilanSante {
  const juger = (cle: CleBrique, mesure: number | null, seuil: Seuil): Brique => ({ cle, mesure, etat: etat(mesure, seuil) });
  const files = e.latencesFiles !== null && e.chargeFiles !== null ? { latences: e.latencesFiles, charge: e.chargeFiles } : null;
  const retard = (file: string): number | null => (files ? retardFile(files.latences, files.charge, file) : null);
  const connexionsPourcent = e.connexions && e.connexions.max > 0 ? (100 * e.connexions.utilisees) / e.connexions.max : null;

  // Un worker arrêté garde sa ligne et son vieux battement : c'est ce qui le rend rouge, sans liste de rôles attendus.
  const plusVieux = e.workers ? [...e.workers].sort((a, b) => b.ageSeconds - a.ageSeconds)[0] : undefined;
  const workers: Brique = e.workers === null
    ? { cle: 'workers', ...INDISPONIBLE }
    : plusVieux
      ? { ...juger('workers', plusVieux.ageSeconds, SEUILS_SANTE.battement), detail: plusVieux.role }
      // Aucun worker n'a jamais battu : rien ne traite les files.
      : { cle: 'workers', mesure: null, etat: 'rouge' };

  const briques: Brique[] = [
    e.latencesHttp === null ? { cle: 'api', ...INDISPONIBLE } : juger('api', partErreurs(e.latencesHttp), SEUILS_SANTE.erreurs),
    workers,
    e.connexions === null ? { cle: 'base', ...INDISPONIBLE } : juger('base', connexionsPourcent, SEUILS_SANTE.connexions),
    files ? juger('entrants', retard(FILE_ENTRANTS), SEUILS_SANTE.entrants) : { cle: 'entrants', ...INDISPONIBLE },
    files ? juger('accuses', retard(FILE_ACCUSES), SEUILS_SANTE.accuses) : { cle: 'accuses', ...INDISPONIBLE },
  ];

  // La jauge : chaque signal de capacité rapporté à son seuil rouge ; le plus haut décide. Un signal illisible ne
  // compte pas, et la jauge le dit (`partielle`) au lieu d'afficher une marge pleine sans prévenir.
  const ratios: Array<[Jauge['signal'], number]> = [
    ['accuses', (retard(FILE_ACCUSES) ?? 0) / SEUILS_SANTE.accuses.rouge],
    ['entrants', (retard(FILE_ENTRANTS) ?? 0) / SEUILS_SANTE.entrants.rouge],
    ['base', (connexionsPourcent ?? 0) / SEUILS_SANTE.connexions.rouge],
  ];
  const [signal, ratio] = ratios.reduce((pire, r) => (r[1] > pire[1] ? r : pire));
  return {
    briques,
    jauge: {
      margePourcent: Math.max(0, Math.min(100, Math.round(100 * (1 - ratio)))),
      signal,
      partielle: files === null || e.connexions === null,
    },
  };
}
