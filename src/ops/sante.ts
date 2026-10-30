import type { WorkerHeartbeatRow } from './heartbeat-store.pg';
import type { LatenceHttpRow } from './latence-http';
import type { QueueLatenceRow, QueueLoadRow } from './store.pg';
import type { MesuresCockpit } from './cockpit';
import type { MemoireWorker } from './memoire-workers.pg';
import { SEUILS_DEFAUT, type SeuilsCapacite } from './seuils';

/**
 * L'ONGLET SANTÉ DE /OPS (refonte, lot 1 : `docs/superpowers/specs/2026-10-27-ops-refonte-design.md`). Une pastille
 * par brique, verte, orange ou rouge, à partir des mesures qui existent déjà, et la jauge de capacité : la marge avant
 * de devoir grossir, sur le PIRE des signaux de capacité. Pur : la route lit, cette fonction juge, l'écran met en
 * mots (il porte la langue).
 */

export type EtatBrique = 'vert' | 'orange' | 'rouge';

/**
 * Les seuils par défaut (la spec, bancs du 2026-10-27). Réglables dans `/ops` depuis le lot 4 (`src/ops/seuils.ts`) :
 * la route lit ceux de la base et les passe à `evaluerSante` ; ceux-ci ne servent qu'à défaut.
 */
export const SEUILS_SANTE: SeuilsCapacite = SEUILS_DEFAUT;

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

export type CleBrique = 'api' | 'workers' | 'memoire-workers' | 'machine' | 'base' | 'processeur-base' | 'entrants' | 'accuses' | 'hubspot';

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
  /** Pour les workers : le rôle le plus en retard ; pour leur mémoire : le plus chargé. */
  detail?: string;
  /** Pour l'API : les requêtes de l'heure, dont l'alerte exige davantage que l'écran (`veille-sante.ts`). */
  effectif?: number;
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
  /** La mémoire de chaque worker, relevée par lui (les relevés frais seulement). */
  memoires: MemoireWorker[] | null;
  /**
   * Cockpit (lot 2). Non configuré (aucun jeton) : ses briques n'existent pas. Configuré : `mesures` vaut `null` quand
   * Cockpit n'a rien rendu, et chaque signal `null` quand lui seul est illisible.
   */
  cockpit: { configure: false } | { configure: true; mesures: MesuresCockpit | null };
}

export interface Jauge {
  /** De 0 (un seuil rouge est atteint) à 100 (rien ne tire). */
  margePourcent: number;
  /** Le signal le plus tendu. */
  signal: 'accuses' | 'entrants' | 'base' | 'processeur-base' | 'machine' | 'memoire-workers';
  /** Une des lectures de capacité a échoué : la marge ne compte que les autres. */
  partielle: boolean;
}

export interface BilanSante {
  briques: Brique[];
  jauge: Jauge;
}

const FILE_ENTRANTS = 'webhook';
const FILE_ACCUSES = 'webhook-status';
/** Les seules files dont Santé juge le retard : leur latence ne se lit que pour elles (`sourcesSante`). */
export const FILES_JUGEES_SANTE: readonly string[] = [FILE_ENTRANTS, FILE_ACCUSES];

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

function partErreurs(lignes: LatenceHttpRow[]): { part: number | null; effectif: number } {
  const service = lignes.filter((l) => routeDuService(l.route));
  const total = service.reduce((s, l) => s + l.requetes, 0);
  if (total < EFFECTIF_MIN_API) return { part: null, effectif: total };
  const erreurs = service.filter((l) => l.code >= 500).reduce((s, l) => s + l.requetes, 0);
  return { part: (100 * erreurs) / total, effectif: total };
}

/** La part de sa limite qu'occupe le worker le plus chargé ; `null` sans aucun relevé qui porte une limite. */
function memoireLaPlusHaute(memoires: MemoireWorker[]): { pourcent: number; role: string } | null {
  let pire: { pourcent: number; role: string } | null = null;
  for (const m of memoires) {
    if (m.limiteOctets === null || m.limiteOctets <= 0) continue;
    const pourcent = (100 * m.utiliseOctets) / m.limiteOctets;
    if (!pire || pourcent > pire.pourcent) pire = { pourcent, role: m.role };
  }
  return pire;
}

/**
 * Au-delà, un worker qui bat sans relevé frais de sa mémoire est un relevé qui échoue, pas un démarrage : il a eu le
 * temps de faire son premier relevé (une minute, plus le décalage de lissage du registre).
 */
export const DELAI_PREMIER_RELEVE_MEMOIRE_MS = 3 * 60_000;

export function evaluerSante(e: EntreesSante, maintenant = Date.now(), seuils: SeuilsCapacite = SEUILS_DEFAUT): BilanSante {
  const juger = (cle: CleBrique, mesure: number | null, seuil: Seuil): Brique => ({ cle, mesure, etat: etat(mesure, seuil) });
  const files = e.latencesFiles !== null && e.chargeFiles !== null ? { latences: e.latencesFiles, charge: e.chargeFiles } : null;
  const retard = (file: string): number | null => (files ? retardFile(files.latences, files.charge, file) : null);
  const connexionsPourcent = e.connexions && e.connexions.max > 0 ? (100 * e.connexions.utilisees) / e.connexions.max : null;
  const memoire = e.memoires ? memoireLaPlusHaute(e.memoires) : null;
  const cockpit = e.cockpit.configure ? e.cockpit.mesures : null;
  const erreursApi = e.latencesHttp === null ? null : partErreurs(e.latencesHttp);
  // Un signal de Cockpit : illisible si Cockpit entier ou ce signal seul n'a rien rendu.
  const deCockpit = (cle: CleBrique, valeur: number | null | undefined, seuil: Seuil): Brique =>
    (valeur === null || valeur === undefined ? { cle, ...INDISPONIBLE } : juger(cle, valeur, seuil));

  // Un worker arrêté garde sa ligne et son vieux battement : c'est ce qui le rend rouge, sans liste de rôles attendus.
  const plusVieux = e.workers ? [...e.workers].sort((a, b) => b.ageSeconds - a.ageSeconds)[0] : undefined;
  const workers: Brique = e.workers === null
    ? { cle: 'workers', ...INDISPONIBLE }
    : plusVieux
      ? { ...juger('workers', plusVieux.ageSeconds, seuils.battement), detail: plusVieux.role }
      // Aucun worker n'a jamais battu : rien ne traite les files.
      : { cle: 'workers', mesure: null, etat: 'rouge' };
  // Un worker vivant, démarré depuis plus de trois minutes, sans relevé frais : son relevé échoue (sous saturation, c'est
  // justement l'écriture qui tombe). Orange, pas le vert d'un « rien à juger ».
  const muet = e.memoires === null ? undefined : (e.workers ?? []).find((w) => w.ageSeconds < seuils.battement.orange
    && w.bootedAt !== null && maintenant - Date.parse(w.bootedAt) > DELAI_PREMIER_RELEVE_MEMOIRE_MS
    && !e.memoires!.some((m) => m.role === w.role));
  const memoireWorkers: Brique = e.memoires === null
    ? { cle: 'memoire-workers', ...INDISPONIBLE }
    : muet
      ? { cle: 'memoire-workers', ...INDISPONIBLE, detail: muet.role }
      : memoire
      ? { ...juger('memoire-workers', memoire.pourcent, seuils.memoireWorker), detail: memoire.role }
      // Aucun relevé frais (juste après un déploiement, ou hors d'un conteneur) : rien à juger, les battements disent la vie.
      : juger('memoire-workers', null, seuils.memoireWorker);

  const briques: Brique[] = [
    erreursApi === null
      ? { cle: 'api', ...INDISPONIBLE }
      : { ...juger('api', erreursApi.part, seuils.erreurs), effectif: erreursApi.effectif },
    workers,
    memoireWorkers,
    ...(e.cockpit.configure ? [deCockpit('machine', cockpit?.machineProcesseur, seuils.processeurMachine)] : []),
    e.connexions === null ? { cle: 'base', ...INDISPONIBLE } : juger('base', connexionsPourcent, seuils.connexions),
    ...(e.cockpit.configure ? [deCockpit('processeur-base', cockpit?.baseProcesseur, seuils.processeurBase)] : []),
    files ? juger('entrants', retard(FILE_ENTRANTS), seuils.entrants) : { cle: 'entrants', ...INDISPONIBLE },
    files ? juger('accuses', retard(FILE_ACCUSES), seuils.accuses) : { cle: 'accuses', ...INDISPONIBLE },
    // La porte HubSpot : éveillée ou endormie, jamais une panne (elle s'endort à dessein). Le nombre de copies.
    ...(e.cockpit.configure
      ? [cockpit?.hubspotCopies === null || cockpit?.hubspotCopies === undefined
        ? { cle: 'hubspot' as const, ...INDISPONIBLE }
        : { cle: 'hubspot' as const, mesure: cockpit.hubspotCopies, etat: 'vert' as const }]
      : []),
  ];

  // La jauge : chaque signal de capacité rapporté à son seuil rouge ; le plus haut décide. Un signal illisible ne
  // compte pas, et la jauge le dit (`partielle`) au lieu d'afficher une marge pleine sans prévenir.
  const ratios: Array<[Jauge['signal'], number]> = [
    ['accuses', (retard(FILE_ACCUSES) ?? 0) / seuils.accuses.rouge],
    ['entrants', (retard(FILE_ENTRANTS) ?? 0) / seuils.entrants.rouge],
    ['base', (connexionsPourcent ?? 0) / seuils.connexions.rouge],
    ['processeur-base', (cockpit?.baseProcesseur ?? 0) / seuils.processeurBase.rouge],
    ['machine', (cockpit?.machineProcesseur ?? 0) / seuils.processeurMachine.rouge],
    ['memoire-workers', (memoire?.pourcent ?? 0) / seuils.memoireWorker.rouge],
  ];
  const [signal, ratio] = ratios.reduce((pire, r) => (r[1] > pire[1] ? r : pire));
  const cockpitIllisible = e.cockpit.configure
    && (cockpit === null || cockpit.baseProcesseur === null || cockpit.machineProcesseur === null);
  return {
    briques,
    jauge: {
      margePourcent: Math.max(0, Math.min(100, Math.round(100 * (1 - ratio)))),
      signal,
      partielle: files === null || e.connexions === null || e.memoires === null || muet !== undefined || cockpitIllisible,
    },
  };
}
