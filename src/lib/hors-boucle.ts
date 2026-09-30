import { Worker } from 'node:worker_threads';
import { journaliser } from './journal';

/**
 * Lire un fichier déposé, ou une page web, HORS de la boucle d'événements, dans un worker qu'on peut tuer.
 *
 * 🔴 Relevé le 2026-09-30 par deux relectures : sous toutes les bornes posées sur un CSV (colonnes, lignes), des
 * fichiers de quelques centaines de Ko tenaient la boucle de `mba-api` des minutes (guillemets mal placés suivis
 * d'espaces, doublons d'en-tête, puis les documents de la connaissance, puis les pages d'un site). Chaque borne
 * fermait une forme, chaque relecture en trouvait d'autres : on borne donc le temps et la mémoire du worker, plus la
 * forme.
 *
 * ⚠️ Ce qui revient au fil principal, lui, n'est pas borné par le worker : c'est à chaque appelant de ne rendre que ce
 * dont il a besoin, sous une forme compacte (les fiches d'un document, les rangées d'un CSV indexées par numéro de
 * colonne). Le résultat revient en JSON, deux fois et demie moins cher à relire que le clone structuré.
 *
 * Un lecteur (`avecLecteur`) garde son worker le temps d'une requête : un aperçu de site y lit ses cinquante pages en
 * ne payant qu'un démarrage (0,35 à 0,5 s, tsx compris), au lieu d'un par lecture. `horsBoucle` en est la lecture
 * unique.
 */

/** Une lecture refusée par ses bornes (échéance, mémoire, trop de lectures à la fois) : le client lit le message. */
export class LectureInterrompue extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export interface OptionsLecture {
  /**
   * Le temps de lecture CUMULÉ du lecteur ; au-delà, le worker est tué et la lecture refusée en 400. Défaut 10 s : le
   * plus gros vrai CSV (762 600 numéros) en coûte 3 sur le poste, 5,9 en production, soit une marge de 1,7
   * (`todo.md`). Cumulé, et pas par lecture : une page hostile tiendrait sinon un worker jusqu'à l'échéance, cinquante
   * fois pour un seul aperçu de site.
   */
  delaiMs?: number;
  /** Le tas du worker. Défaut 1 024 Mo : le plus gros vrai CSV en demande 440. ⚠️ `--max-old-space-size` l'emporte. */
  memoireMo?: number;
  /** Ce qu'on lit, pour que le refus parle de ce que le client a donné. Défaut : un fichier. */
  nature?: 'fichier' | 'pages';
  /** Au-delà de ce repos entre deux lectures, le lecteur rend son worker (`REPOS_MS`). */
  reposMs?: number;
}

const REFUS = {
  fichier: {
    echeance: (s: number) => `La lecture de ce fichier a dépassé ${s} s : vérifiez son format, ou découpez-le en plusieurs fichiers plus petits.`,
    memoire: 'La lecture de ce fichier demande trop de mémoire : découpez-le en plusieurs fichiers plus petits.',
  },
  pages: {
    echeance: (s: number) => `La lecture de ces pages a dépassé ${s} s : importez une partie du site à la fois.`,
    memoire: 'La lecture de ces pages demande trop de mémoire : importez une partie du site à la fois.',
  },
};

/**
 * Au plus quatre lectures EN COURS à la fois : une lecture occupe un cœur, et le VPS en a huit pour tous ses services.
 * Les routes de la FAQ et des pièces jointes de l'assistant n'ont pas le plafond coûteux par espace ; sans cette
 * limite, des lectures en rafale prendraient tous les cœurs. Un lecteur au repos (un aperçu qui attend le réseau entre
 * deux pages) n'occupe aucune place : il ne prend pas de cœur, et garder sa place rendrait 429 à tous les espaces dès
 * que quatre sites seraient parcourus à la fois. ⚠️ Ce plafond borne donc les lectures, PAS les workers vivants : c'est
 * `REPOS_MS` qui borne ceux-là. ponytail: un compteur par process et pour tous les espaces, à partager par espace (et
 * en base, le jour où l'API a plusieurs instances).
 */
const LECTURES_MAX = 4;
let lecturesEnCours = 0;

/**
 * Un lecteur au repos rend son worker au bout de 5 s, et sa lecture suivante en démarre un autre (0,35 à 0,5 s,
 * comptés dans son échéance). Relevé par la relecture du 2026-10-01 : un worker au repos pèse 15 à 25 Mo, et un
 * aperçu attend surtout le réseau. Un site aux liens lents (jusqu'à 10 s chacun, par redirection, et une page écartée
 * ne compte pas dans les cinquante) garderait sinon un worker par aperçu pendant des heures : quelques centaines
 * d'aperçus en vol feraient tomber `mba-api`, qui n'a pas de limite de mémoire.
 */
const REPOS_MS = 5_000;

const WORKER = new URL('./hors-boucle-worker.mjs', import.meta.url);

/** Un refus des bornes : journalisé, parce qu'un vrai fichier refusé en production serait sinon invisible. */
function refus(fonction: string, raison: string, message: string, statusCode: number): LectureInterrompue {
  journaliser('warn', 'lecture_interrompue', { fonction, raison, statusCode });
  return new LectureInterrompue(message, statusCode);
}

/** Un worker gardé le temps d'un travail : plusieurs lectures, une à la fois, sous une échéance cumulée. */
export interface Lecteur {
  /** `fonction`, un export de `module`, appelée avec `args` dans le worker ; les octets y arrivent en `Buffer`. */
  lire<T>(module: URL, fonction: string, args: unknown[]): Promise<T>;
}

type Reponse = { json?: string; erreur?: { message: string; statusCode?: number; pile?: string } };

interface LectureEnCours {
  fonction: string;
  debut: number;
  minuteur: NodeJS.Timeout;
  resoudre(reponse: Reponse): void;
  rejeter(err: Error): void;
}

/**
 * Ouvre un lecteur pour `travail`, et tue son worker quand le travail finit, quelle qu'en soit l'issue : un lecteur
 * laissé ouvert garderait un worker vivant par requête, jusqu'à la chute de `mba-api`. Le worker ne démarre qu'à la
 * première lecture (un aperçu dont aucune page ne répond n'en coûte aucun, un refus 429 non plus), et il est rendu
 * après `REPOS_MS` sans lecture.
 */
export async function avecLecteur<T>(options: OptionsLecture, travail: (lecteur: Lecteur) => Promise<T>): Promise<T> {
  const { delaiMs = 10_000, memoireMo = 1_024, nature = 'fichier', reposMs = REPOS_MS } = options;
  let worker: Worker | null = null;
  /** Pourquoi le lecteur ne lit plus (échéance, mémoire, worker sorti, travail fini), ou `null` tant qu'il lit. */
  let mort: Error | null = null;
  /** Une lecture à la fois : le worker ne rend pas d'identifiant avec sa réponse. */
  let enCours: LectureEnCours | null = null;
  let consomme = 0;
  let repos: NodeJS.Timeout | undefined;

  /** Rend le worker sans fermer le lecteur : sa lecture suivante en démarrera un autre. */
  const rendre = (): void => {
    const w = worker;
    if (w === null || enCours !== null) return;
    worker = null;
    w.removeAllListeners();
    // Sans écouteur, un `error` que le worker lèverait en mourant serait levé comme une exception, dans le process.
    w.on('error', () => undefined);
    void w.terminate();
  };

  /** La lecture en cours s'achève : sa place se libère, son temps s'ajoute au cumul, et le repos commence. */
  const achever = (): LectureEnCours | null => {
    const lecture = enCours;
    if (lecture === null) return null;
    enCours = null;
    lecturesEnCours -= 1;
    clearTimeout(lecture.minuteur);
    consomme += performance.now() - lecture.debut;
    if (mort === null) repos = setTimeout(rendre, reposMs);
    return lecture;
  };

  /** Le lecteur ne lit plus : le worker est tué, et la lecture en cours rejetée avec la même raison. */
  const tuer = (raison: Error): void => {
    clearTimeout(repos);
    if (mort === null) {
      mort = raison;
      void worker?.terminate();
    }
    achever()?.rejeter(raison);
  };

  const demarrer = (): Worker => {
    const w = new Worker(WORKER, { resourceLimits: { maxOldGenerationSizeMb: memoireMo } });
    w.on('message', (m: Reponse) => achever()?.resoudre(m));
    w.once('error', (err: Error & { code?: string }) => tuer(err.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? refus(enCours?.fonction ?? '', 'memoire', REFUS[nature].memoire, 400)
      : err));
    w.once('exit', (code) => tuer(new Error(`lecture interrompue, le worker est sorti (code ${code})`)));
    return w;
  };

  const lecteur: Lecteur = {
    lire<R>(module: URL, fonction: string, args: unknown[]): Promise<R> {
      if (mort !== null) return Promise.reject(mort);
      if (enCours !== null) return Promise.reject(new Error('une lecture à la fois par lecteur : attendez la précédente'));
      if (lecturesEnCours >= LECTURES_MAX) {
        return Promise.reject(refus(fonction, 'occupe', 'Trop de lectures en cours sur le serveur : réessayez dans un instant.', 429));
      }
      clearTimeout(repos);
      const lecture = new Promise<Reponse>((resoudre, rejeter) => {
        try {
          worker ??= demarrer();
          worker.postMessage({ module: module.href, fonction, args });
        } catch (err) {
          // 🔴 Avant d'occuper une place : une lecture qui ne part pas (argument que le clonage refuse, fil refusé) ne
          // doit pas laisser le compteur monter, sinon quatre échecs suffiraient à rendre 429 à tout le monde jusqu'au
          // redémarrage.
          rejeter(err);
          return;
        }
        lecturesEnCours += 1;
        const minuteur = setTimeout(() => tuer(refus(fonction, 'echeance', REFUS[nature].echeance(Math.round(delaiMs / 1000)), 400)),
          Math.max(0, delaiMs - consomme));
        enCours = { fonction, debut: performance.now(), minuteur, resoudre, rejeter };
      }).then((m) => {
        if (m.erreur === undefined) return JSON.parse(m.json ?? 'null') as R;
        // L'erreur de la fonction garde son message et son `statusCode` : un refus lisible reste un refus lisible.
        const err = Object.assign(new Error(m.erreur.message), m.erreur.statusCode === undefined ? {} : { statusCode: m.erreur.statusCode });
        if (m.erreur.pile !== undefined) err.stack = m.erreur.pile;
        throw err;
      });
      // Une lecture que son travail n'attend pas serait rejetée à la fin du travail (« lecteur fermé ») sans personne
      // pour l'entendre, et un rejet sans gestionnaire fait tomber le process. Qui l'attend reçoit toujours le rejet.
      lecture.catch(() => undefined);
      return lecture;
    },
  };

  try {
    return await travail(lecteur);
  } finally {
    tuer(new Error('lecteur fermé : son travail est fini'));
  }
}

/** `fonction`, un export de `module`, appelée avec `args` dans un worker ouvert pour elle seule. */
export function horsBoucle<T>(module: URL, fonction: string, args: unknown[], options: OptionsLecture = {}): Promise<T> {
  return avecLecteur(options, (lecteur) => lecteur.lire<T>(module, fonction, args));
}
