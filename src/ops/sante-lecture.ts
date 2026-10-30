import type { WorkerHeartbeatRow } from './heartbeat-store.pg';
import type { LatenceHttpRow } from './latence-http';
import type { QueueLatenceRow, QueueLoadRow } from './store.pg';
import type { MemoireWorker } from './memoire-workers.pg';
import type { LecteurCockpit } from './cockpit';
import { FILES_JUGEES_SANTE, type EntreesSante } from './sante';

/**
 * Les lectures dont Santé juge (refonte de /ops, lots 1 et 2), en UN endroit : la route `/ops/sante` et la veille qui
 * envoie les alertes (lot 4) jugent sur exactement les mêmes mesures, sinon l'écran dirait vert quand Telegram crie
 * rouge. Chaque lecture en échec rend `null`, jamais une liste vide : sous saturation, « illisible » n'est pas
 * « aucun trafic ».
 */
export interface SourcesSante {
  battements(): Promise<WorkerHeartbeatRow[]>;
  /** Le dernier quart d'heure : un pic résolu ne garde pas la pastille rouge une heure. */
  latencesFiles(): Promise<QueueLatenceRow[]>;
  chargeFiles(): Promise<QueueLoadRow[]>;
  latencesHttp(): Promise<LatenceHttpRow[]>;
  connexions(): Promise<{ utilisees: number; max: number }>;
  memoires(): Promise<MemoireWorker[]>;
  /** `null` tant que le jeton Cockpit n'est pas posé. */
  cockpit: LecteurCockpit | null;
}

/** Les fenêtres où Santé juge : le dernier quart d'heure des files, la dernière heure de l'API. */
export const FENETRE_FILES_SANTE_HEURES = 0.25;
export const FENETRE_HTTP_SANTE_HEURES = 1;

/**
 * Les sources de Santé depuis les stores, pour la route ET la veille : les fenêtres et les files jugées s'écrivent ici,
 * une fois, au lieu d'être recopiées dans deux câblages (relecture du lot 4). Chaque store s'appelle sur son objet.
 */
export function sourcesSante(d: {
  heartbeat: { lister(): Promise<WorkerHeartbeatRow[]> };
  files: {
    getQueueLatence(fenetreHeures: number, files?: readonly string[]): Promise<QueueLatenceRow[]>;
    getQueueLoad(): Promise<QueueLoadRow[]>;
  };
  latencesHttp: { lire(heures: number): Promise<LatenceHttpRow[]> };
  connexions(): Promise<{ utilisees: number; max: number }>;
  memoires(): Promise<MemoireWorker[]>;
  cockpit: LecteurCockpit | null;
}): SourcesSante {
  return {
    battements: () => d.heartbeat.lister(),
    latencesFiles: () => d.files.getQueueLatence(FENETRE_FILES_SANTE_HEURES, FILES_JUGEES_SANTE),
    chargeFiles: () => d.files.getQueueLoad(),
    latencesHttp: () => d.latencesHttp.lire(FENETRE_HTTP_SANTE_HEURES),
    connexions: () => d.connexions(),
    memoires: () => d.memoires(),
    cockpit: d.cockpit,
  };
}

export async function lireEntreesSante(s: SourcesSante): Promise<EntreesSante> {
  const auMieux = <T>(lecture: () => Promise<T>): Promise<T | null> => Promise.resolve().then(lecture).catch(() => null);
  const [workers, latencesFiles, chargeFiles, latencesHttp, connexions, memoires, mesures] = await Promise.all([
    auMieux(() => s.battements()),
    auMieux(() => s.latencesFiles()),
    auMieux(() => s.chargeFiles()),
    auMieux(() => s.latencesHttp()),
    auMieux(() => s.connexions()),
    auMieux(() => s.memoires()),
    s.cockpit ? auMieux(() => s.cockpit!.mesures()) : Promise.resolve(null),
  ]);
  return {
    workers, latencesFiles, chargeFiles, latencesHttp, connexions, memoires,
    cockpit: s.cockpit ? { configure: true, mesures } : { configure: false },
  };
}
