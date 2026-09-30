import { Worker } from 'node:worker_threads';
import { journaliser } from './journal';

/**
 * Lire un fichier déposé HORS de la boucle d'événements, dans un worker qu'on peut tuer.
 *
 * 🔴 Relevé le 2026-09-30 par deux relectures : sous toutes les bornes posées sur un CSV (colonnes, lignes), des
 * fichiers de quelques centaines de Ko tenaient la boucle de `mba-api` des minutes (guillemets mal placés suivis
 * d'espaces, doublons d'en-tête, puis les documents de la connaissance). Chaque borne fermait une forme, chaque
 * relecture en trouvait d'autres : on borne donc le temps et la mémoire du worker, plus la forme.
 *
 * ⚠️ Ce qui revient au fil principal, lui, n'est pas borné par le worker : c'est à chaque appelant de ne rendre que ce
 * dont il a besoin, sous une forme compacte (les fiches d'un document, les rangées d'un CSV indexées par numéro de
 * colonne). Le résultat revient en JSON, deux fois et demie moins cher à relire que le clone structuré. Un worker par
 * appel, sans pool : il démarre en 0,35 à 0,5 s (tsx compris), acceptable pour un import ou un dépôt de document.
 */

/** Une lecture refusée par ses bornes (échéance, mémoire, trop de lectures à la fois) : le client lit le message. */
export class LectureInterrompue extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export interface OptionsLecture {
  /** Au-delà, le worker est tué et la lecture refusée en 400. Défaut 10 s : le plus gros vrai CSV en coûte 3. */
  delaiMs?: number;
  /** Le tas du worker. Défaut 1 024 Mo : le plus gros vrai CSV en demande 440. ⚠️ `--max-old-space-size` l'emporte. */
  memoireMo?: number;
}

/**
 * Au plus quatre lectures à la fois : un worker occupe un cœur, et le VPS en a huit pour tous ses services. Les routes
 * de la FAQ et des pièces jointes de l'assistant n'ont pas le plafond coûteux par espace ; sans cette limite, des
 * lectures en rafale prendraient tous les cœurs. ponytail: un compteur par process et pour tous les espaces, à
 * partager par espace (et en base, le jour où l'API a plusieurs instances).
 */
const LECTURES_MAX = 4;
let lecturesEnCours = 0;

const WORKER = new URL('./hors-boucle-worker.mjs', import.meta.url);

/** Un refus des bornes : journalisé, parce qu'un vrai fichier refusé en production serait sinon invisible. */
function refus(fonction: string, raison: string, message: string, statusCode: number): LectureInterrompue {
  journaliser('warn', 'lecture_interrompue', { fonction, raison, statusCode });
  return new LectureInterrompue(message, statusCode);
}

/** `fonction`, un export de `module`, appelée avec `args` dans un worker ; les octets y arrivent en `Buffer`. */
export function horsBoucle<T>(module: URL, fonction: string, args: unknown[], options: OptionsLecture = {}): Promise<T> {
  const { delaiMs = 10_000, memoireMo = 1_024 } = options;
  if (lecturesEnCours >= LECTURES_MAX) {
    return Promise.reject(refus(fonction, 'occupe', 'Trop de fichiers en cours de lecture sur le serveur : réessayez dans un instant.', 429));
  }
  return new Promise<T>((resoudre, rejeter) => {
    let worker: Worker;
    try {
      worker = new Worker(WORKER, {
        workerData: { module: module.href, fonction, args },
        resourceLimits: { maxOldGenerationSizeMb: memoireMo },
      });
    } catch (err) {
      // 🔴 Avant d'occuper une place : un worker qui ne démarre pas (argument non clonable, fil refusé) ne doit pas
      // laisser le compteur monter, sinon quatre échecs suffiraient à rendre 429 à tout le monde jusqu'au redémarrage.
      rejeter(err);
      return;
    }
    lecturesEnCours += 1;
    let fini = false;
    const finir = (issue: () => void): void => {
      if (fini) return;
      fini = true;
      lecturesEnCours -= 1;
      clearTimeout(minuteur);
      void worker.terminate();
      issue();
    };
    const minuteur = setTimeout(() => finir(() => rejeter(refus(fonction, 'echeance',
      `La lecture de ce fichier a dépassé ${Math.round(delaiMs / 1000)} s : vérifiez son format, ou découpez-le en plusieurs fichiers plus petits.`,
      400))), delaiMs);
    worker.once('message', (m: { json?: string; erreur?: { message: string; statusCode?: number; pile?: string } }) => finir(() => {
      if (m.erreur === undefined) {
        resoudre(JSON.parse(m.json ?? 'null') as T);
        return;
      }
      // L'erreur de la fonction garde son message et son `statusCode` : un refus lisible reste un refus lisible.
      const err = Object.assign(new Error(m.erreur.message), m.erreur.statusCode === undefined ? {} : { statusCode: m.erreur.statusCode });
      if (m.erreur.pile !== undefined) err.stack = m.erreur.pile;
      rejeter(err);
    }));
    worker.once('error', (err: Error & { code?: string }) => finir(() => rejeter(err.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? refus(fonction, 'memoire', 'La lecture de ce fichier demande trop de mémoire : découpez-le en plusieurs fichiers plus petits.', 400)
      : err)));
    worker.once('exit', (code) => finir(() => rejeter(new Error(`lecture interrompue, le worker est sorti (code ${code})`))));
  });
}
