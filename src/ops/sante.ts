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
  /** Part des réponses 5xx de l'API sur la dernière heure, en pourcentage. */
  erreurs: { orange: 1, rouge: 5 },
  /** Âge du dernier battement d'un worker, en secondes. */
  battement: { orange: 120, rouge: 300 },
} as const;

type Seuil = { orange: number; rouge: number };

export type CleBrique = 'api' | 'workers' | 'base' | 'entrants' | 'accuses';

export interface Brique {
  cle: CleBrique;
  etat: EtatBrique;
  /** La valeur jugée, dans l'unité de son seuil ; `null` = rien à mesurer (aucun trafic), donc vert. */
  mesure: number | null;
  /** Pour les workers : le rôle le plus en retard. */
  detail?: string;
}

export interface EntreesSante {
  workers: WorkerHeartbeatRow[];
  /** La latence des files sur la dernière heure (`getQueueLatence(1)`). */
  latencesFiles: QueueLatenceRow[];
  /** La charge des files à l'instant (`getQueueLoad`). */
  chargeFiles: QueueLoadRow[];
  /** Les latences HTTP de la dernière heure. */
  latencesHttp: LatenceHttpRow[];
  /** Les connexions de la base ; `null` = lecture en échec. */
  connexions: { utilisees: number; max: number } | null;
}

export interface Jauge {
  /** De 0 (un seuil rouge est atteint) à 100 (rien ne tire). */
  margePourcent: number;
  /** Le signal le plus tendu. */
  signal: Exclude<CleBrique, 'api' | 'workers'>;
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

/** Le retard d'une file : le pire du p95 de l'heure et de l'âge du plus vieux en attente (une file figée se voit tout de suite). */
function retardFile(e: EntreesSante, file: string): number | null {
  const p95 = e.latencesFiles.find((l) => l.queue === file && l.echantillons > 0)?.boutEnBoutP95Secondes;
  const age = e.chargeFiles.find((c) => c.queue === file)?.ageMaxSecondes;
  const valeurs = [p95, age].filter((v): v is number => typeof v === 'number' && v > 0);
  return valeurs.length === 0 ? null : Math.max(...valeurs);
}

function partErreurs(lignes: LatenceHttpRow[]): number | null {
  const total = lignes.reduce((s, l) => s + l.requetes, 0);
  if (total === 0) return null;
  const erreurs = lignes.filter((l) => l.code >= 500).reduce((s, l) => s + l.requetes, 0);
  return (100 * erreurs) / total;
}

export function evaluerSante(e: EntreesSante): BilanSante {
  // Un worker arrêté garde sa ligne et son vieux battement : c'est ce qui le rend rouge, sans liste de rôles attendus.
  const plusVieux = [...e.workers].sort((a, b) => b.ageSeconds - a.ageSeconds)[0];
  const connexionsPourcent = e.connexions && e.connexions.max > 0 ? (100 * e.connexions.utilisees) / e.connexions.max : null;
  const briques: Brique[] = [
    { cle: 'api', mesure: partErreurs(e.latencesHttp), etat: etat(partErreurs(e.latencesHttp), SEUILS_SANTE.erreurs) },
    plusVieux
      ? { cle: 'workers', mesure: plusVieux.ageSeconds, etat: etat(plusVieux.ageSeconds, SEUILS_SANTE.battement), detail: plusVieux.role }
      // Aucun worker n'a jamais battu : rien ne traite les files.
      : { cle: 'workers', mesure: null, etat: 'rouge' },
    { cle: 'base', mesure: connexionsPourcent, etat: etat(connexionsPourcent, SEUILS_SANTE.connexions) },
    { cle: 'entrants', mesure: retardFile(e, FILE_ENTRANTS), etat: etat(retardFile(e, FILE_ENTRANTS), SEUILS_SANTE.entrants) },
    { cle: 'accuses', mesure: retardFile(e, FILE_ACCUSES), etat: etat(retardFile(e, FILE_ACCUSES), SEUILS_SANTE.accuses) },
  ];

  // La jauge : chaque signal de capacité rapporté à son seuil rouge ; le plus haut décide.
  const ratios: Array<[Jauge['signal'], number]> = [
    ['accuses', (retardFile(e, FILE_ACCUSES) ?? 0) / SEUILS_SANTE.accuses.rouge],
    ['entrants', (retardFile(e, FILE_ENTRANTS) ?? 0) / SEUILS_SANTE.entrants.rouge],
    ['base', (connexionsPourcent ?? 0) / SEUILS_SANTE.connexions.rouge],
  ];
  const [signal, ratio] = ratios.reduce((pire, r) => (r[1] > pire[1] ? r : pire));
  return { briques, jauge: { margePourcent: Math.max(0, Math.min(100, Math.round(100 * (1 - ratio)))), signal } };
}
