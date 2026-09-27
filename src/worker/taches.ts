import { messageDe } from '../lib/erreur';
/**
 * Registre des tâches périodiques du worker. Enregistrer une tâche et l'arrêter sont le même geste : on ne
 * peut plus en oublier une dans l'arrêt propre (une passe qui part pendant qu'on ferme le pool laisse une
 * erreur à chaque déploiement).
 *
 * La première passe n'est lancée que sur demande (`immediat`), et passe par la même garde de ré-entrance que
 * les passes périodiques.
 */

/** Ce qu'une tâche peut demander de plus que sa cadence. */
export interface OptionsTache {
  /** Une première passe tout de suite, sous la même garde que les passes périodiques. */
  immediat?: boolean;
  /**
   * Ce que fait une passe qui lève : le journal et l'alerte de l'appelant. Sans lui, le registre la journalise
   * seul. S'il lève à son tour (l'alerte qui échoue), le registre rattrape encore : rien ne tue le process.
   */
  enEchec?: (err: unknown) => void;
}

export interface RegistreDeTaches {
  /**
   * Programme une passe périodique. La minuterie est `unref` (elle ne retient jamais le process) et elle est
   * retenue pour l'arrêt.
   */
  programmer(nom: string, intervalMs: number, passe: () => void | Promise<void>, options?: OptionsTache): void;
  /** Arrête toutes les tâches programmées. Appelé une fois, dans l'arrêt propre du worker. */
  arreterTout(): void;
  /** Noms des tâches vivantes, dans l'ordre de programmation. Sert au diagnostic et aux tests. */
  noms(): readonly string[];
}

/**
 * Lissage : de combien on retarde le premier tour d'une tâche, pour qu'elles ne sonnent pas toutes ensemble.
 * Toutes partent de t=0 avec des cadences multiples les unes des autres (20 s, 60 s, 5 min...) et se
 * rejoignent périodiquement, ce qui sature le pool de connexions. L'enjeu n'est pas la latence (personne
 * n'attend ces balayages) mais l'indicateur : la saturation du pool est le seul signal qu'on ait, et il ne
 * doit pas être allumé en permanence par une cause connue.
 *
 * Le décalage ne dépasse jamais l'intervalle de la tâche (elle ne tourne jamais moins souvent, seulement plus
 * tard la première fois) et reste sous une minute, la largeur de la collision. Le pas de 2 300 ms ne divise
 * aucune cadence en place, pour qu'aucune tâche ne retombe en face du battement de cœur. Déterministe, pour
 * qu'un démarrage soit reproductible et qu'une minute de pointe s'explique après coup.
 */
const DECALAGE_PAS_MS = 2_300;
/** Le décalage reste dans cette fenêtre : la largeur de la collision. */
const FENETRE_LISSAGE_MS = 60_000;

/**
 * Le décalage de démarrage d'une tâche, depuis son rang d'enregistrement et sa cadence. Fonction pure,
 * exportée pour tester directement le cas où le décalage dépasserait l'intervalle.
 */
export function decalageDeLissage(indice: number, intervalMs: number): number {
  const fenetre = Math.max(1, Math.min(intervalMs, FENETRE_LISSAGE_MS));
  return (indice * DECALAGE_PAS_MS) % fenetre;
}

export function registreDeTaches(): RegistreDeTaches {
  /**
   * Une tâche vit en deux temps (décalage de démarrage, puis minuterie périodique), retenus dans une seule
   * entrée posée avant le décalage : sinon, pendant l'attente, `noms()` la raterait et le refus de doublon
   * laisserait passer un second enregistrement du même nom, dont la minuterie deviendrait impossible à arrêter.
   */
  const taches = new Map<string, { demarrage: ReturnType<typeof setTimeout> | null; intervalle: ReturnType<typeof setInterval> | null }>();
  /** Les passes en cours, par nom, avec le nombre de tours sautés d'affilée. */
  const enCours = new Map<string, number>();

  return {
    programmer(nom, intervalMs, passe, options = {}) {
      if (taches.has(nom)) {
        // Deux tâches du même nom = un copier-coller mal fini. On refuse plutôt que de perdre la première
        // minuterie, qui deviendrait impossible à arrêter.
        throw new Error(`tâche périodique « ${nom} » déjà programmée`);
      }
      // La passe est enveloppée : `setInterval(() => void f())` laisse un rejet non rattrapé si `f` rejette, et
      // un rejet non rattrapé tue le process (Node 15+), par exemple si le `catch` lui-même échoue (alerte qui
      // lève). On journalise et on continue : la passe suivante refera le travail.
      const tour = () => {
        // Garde de ré-entrance : `setInterval` ne saute pas un tour parce que le précédent n'est pas fini, et deux
        // exemplaires du même balayage liraient puis écriraient les mêmes lignes. Le saut est journalisé avec le
        // nombre de tours sautés d'affilée : un balayage qui déborde systématiquement ne doit pas passer inaperçu.
        const sautes = enCours.get(nom);
        if (sautes !== undefined) {
          enCours.set(nom, sautes + 1);
          // eslint-disable-next-line no-console
          console.warn(`tâche « ${nom} » : passe précédente encore en cours, tour sauté (${sautes + 1} d'affilée)`);
          return;
        }
        enCours.set(nom, 0);
        const enEchec = options.enEchec;
        let enVol = Promise.resolve().then(passe);
        if (enEchec) enVol = enVol.catch(enEchec);
        void enVol
          // eslint-disable-next-line no-console
          .catch((err: unknown) => console.error(`tâche « ${nom} » : passe en échec non rattrapée :`, messageDe(err)))
          .finally(() => { enCours.delete(nom); });
      };

      // L'entrée existe dès maintenant, minuterie ou pas : voir le commentaire de `taches`.
      const entree: { demarrage: ReturnType<typeof setTimeout> | null; intervalle: ReturnType<typeof setInterval> | null } = { demarrage: null, intervalle: null };
      taches.set(nom, entree);

      const lancer = (): void => {
        entree.demarrage = null;
        const t = setInterval(tour, intervalMs);
        t.unref();
        entree.intervalle = t;
      };

      // Le décalage ne lance aucune passe, il retarde seulement la minuterie : la première passe périodique
      // arrive à `décalage + intervalle`, et sans `immediat` aucune passe implicite n'est déclenchée.
      const decalage = decalageDeLissage(taches.size - 1, intervalMs);
      if (decalage === 0) {
        lancer();
      } else {
        const d = setTimeout(lancer, decalage);
        d.unref();
        entree.demarrage = d;
      }
      if (options.immediat) tour();
    },

    arreterTout() {
      for (const t of taches.values()) {
        // Les deux : une tâche encore dans son décalage n'a pas de minuterie, et n'arrêter que les minuteries la
        // laisserait démarrer après la fermeture, pendant qu'on ferme le pool.
        if (t.demarrage !== null) clearTimeout(t.demarrage);
        if (t.intervalle !== null) clearInterval(t.intervalle);
      }
      taches.clear();
      // Les passes en vol ne sont pas interrompues (on ne sait pas les annuler), mais leur marque part : un
      // registre réutilisé après un arrêt croirait ses tâches déjà en cours, donc muettes à vie.
      enCours.clear();
    },

    noms() {
      return [...taches.keys()];
    },
  };
}
