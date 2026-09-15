/**
 * Registre des TÂCHES PÉRIODIQUES du worker (lot 3 du programme, 2026-08-31).
 *
 * 🔴 Le problème qu'il supprime, et ce n'est pas une préférence de style. Le worker programmait dix-sept
 * `setInterval` et devait les arrêter un par un, à la main, dans son arrêt propre. Deux étaient déjà passés
 * à travers historiquement, et **les deux balayages de rétention ajoutés le 2026-08-31 y sont passés aussi** :
 * ils n'étaient dans aucune liste d'arrêt, découverts en écrivant ce registre. Un oubli ne casse rien tout de
 * suite (les minuteries sont `unref`, elles ne retiennent pas le process) : il se voit à l'arrêt, quand une
 * passe part pendant qu'on ferme le pool, et laisse une erreur à chaque déploiement.
 *
 * Enregistrer une tâche et l'arrêter deviennent le MÊME geste : on ne peut plus en oublier une.
 *
 * ⚠️ Ce que ce registre ne fait PAS, volontairement : il ne lance pas la première passe. Les appelants qui
 * veulent balayer au démarrage gardent leur `void passe()`, à l'endroit où ils l'écrivaient déjà. Le rendre
 * implicite ferait démarrer quinze balayages qui ne le faisaient pas, ce qui serait un changement de
 * comportement caché dans un refactor.
 *
 * ⚠️ CONSÉQUENCE SUR LA GARDE DE RÉ-ENTRANCE ci-dessous, et c'est pour ça qu'on l'écrit ici : elle protège les
 * passes PÉRIODIQUES entre elles, pas la passe de DÉMARRAGE lancée à côté par l'appelant. Un balayage dont la
 * première passe peut déborder sur le premier tour garde donc sa propre garde (`reveil-parcours` en a une, et
 * elle n'est pas redondante pour cette raison précise). Faire passer les passes de démarrage par le registre
 * est un travail de lot 3 du programme II, avec le regroupement des `register*Jobs`.
 */

export interface RegistreDeTaches {
  /**
   * Programme une passe périodique. La minuterie est `unref` (elle ne retient jamais le process) et elle est
   * retenue pour l'arrêt.
   */
  programmer(nom: string, intervalMs: number, passe: () => void | Promise<void>): void;
  /** Arrête TOUTES les tâches programmées. Appelé une fois, dans l'arrêt propre du worker. */
  arreterTout(): void;
  /** Noms des tâches vivantes, dans l'ordre de programmation. Sert au diagnostic et aux tests. */
  noms(): readonly string[];
}

/**
 * LISSAGE : de combien on retarde le PREMIER tour d'une tâche, pour qu'elles ne sonnent pas toutes ensemble.
 *
 * 🔴 LE DÉFAUT QU'IL SUPPRIME EST UN DÉFAUT D'INDICATEUR, PAS DE PERFORMANCE. Les vingt-trois tâches sont
 * programmées au démarrage, donc elles partent toutes de t=0, et leurs cadences sont des multiples les unes
 * des autres (20 s, 60 s, 5 min, 20 min...). Elles se REJOIGNENT donc périodiquement. Mesuré en production le
 * 2026-09-15 sur 24 h : une minute ordinaire coûte **13 requêtes et zéro attente**, une minute de
 * rendez-vous **26 requêtes et 5 à 10 attentes** sur un pool de huit. Sur 1 763 attentes de la journée,
 * 1 393 viennent de ces minutes-là.
 *
 * ⚠️ **CE N'EST PAS LA LATENCE QU'ON RÉPARE**, et il faut le dire pour que personne ne recalibre ce réglage
 * sur le mauvais chiffre : 240 ms d'attente sur des balayages que PERSONNE n'attend ne coûtent rien. Ce qu'on
 * répare, c'est que la saturation du pool est le seul signal qu'on ait, et qu'il est allumé 272 minutes par
 * jour pour une cause permanente. La migration 0111 a déjà payé exactement cette leçon (« un indicateur qui
 * crie au loup se fait ignorer, et il aurait été ignoré le jour où il aurait eu raison »). Après lissage,
 * rouge redevient un ÉVÉNEMENT.
 *
 * ⚠️ LE DÉCALAGE NE DÉPASSE JAMAIS L'INTERVALLE de la tâche : une tâche ne peut donc pas tourner MOINS
 * souvent qu'on l'a demandée, seulement plus tard la première fois. Et il est plafonné à une minute, parce
 * que la fenêtre de collision mesurée est la minute : décaler un balayage de rétention de six heures de
 * plusieurs heures serait un changement de comportement, pas un lissage.
 *
 * ⚠️ LE PAS N'EST PAS UN NOMBRE ROND, DÉLIBÉRÉMENT : 2 300 ms n'est un diviseur d'aucune des cadences en
 * place (20 s, 60 s, 5 min), donc aucune tâche ne retombe sur le battement de cœur. Un pas de 2 000 aurait
 * remis une tâche sur 20 s exactement en face de lui.
 *
 * ⚠️ DÉTERMINISTE, PAS ALÉATOIRE : deux démarrages du worker produisent le même étalement, donc un
 * comportement reproductible en test comme en production. Un décalage tiré au hasard rendrait une minute de
 * pointe impossible à expliquer après coup.
 */
const DECALAGE_PAS_MS = 2_300;
/** Le décalage reste dans cette fenêtre : c'est la largeur de la collision mesurée. */
const FENETRE_LISSAGE_MS = 60_000;

/**
 * Le décalage de démarrage d'une tâche, depuis son RANG d'enregistrement et sa cadence.
 *
 * Exporté pour être testé seul : c'est une fonction pure, et la tester à travers des minuteries factices
 * cacherait le seul cas qui compte vraiment, celui où le décalage dépasserait l'intervalle.
 */
export function decalageDeLissage(indice: number, intervalMs: number): number {
  const fenetre = Math.max(1, Math.min(intervalMs, FENETRE_LISSAGE_MS));
  return (indice * DECALAGE_PAS_MS) % fenetre;
}

export function registreDeTaches(): RegistreDeTaches {
  /**
   * Une tâche vit en DEUX temps : son décalage de démarrage, puis sa minuterie périodique. Les deux sont
   * retenus ensemble, dans une seule entrée.
   *
   * 🔴 L'ENTRÉE EST POSÉE AVANT LE DÉCALAGE, ET C'EST CE QUI REND LE LISSAGE SÛR. Pendant l'attente, la tâche
   * n'a pas encore de minuterie : un registre indexé sur les seules minuteries la croirait absente, donc
   * `noms()` la raterait et le refus de doublon laisserait passer un second enregistrement du même nom,
   * dont la minuterie deviendrait impossible à arrêter. C'est précisément le défaut que ce registre existe
   * pour supprimer, et le lissage l'aurait rouvert par la petite porte.
   */
  const taches = new Map<string, { demarrage: ReturnType<typeof setTimeout> | null; intervalle: ReturnType<typeof setInterval> | null }>();
  /** Les passes EN COURS, par nom, avec le nombre de tours sautés d'affilée. */
  const enCours = new Map<string, number>();

  return {
    programmer(nom, intervalMs, passe) {
      if (taches.has(nom)) {
        // Deux tâches du même nom = un copier-coller mal fini. On refuse plutôt que de perdre la première
        // minuterie (elle deviendrait impossible à arrêter, exactement le défaut qu'on ferme ici).
        throw new Error(`tâche périodique « ${nom} » déjà programmée`);
      }
      // 🔴 La passe est enveloppée, et ce n'est pas de la prudence décorative. `setInterval(() => void f())`
      // laisse un rejet NON RATTRAPÉ si `f` rejette, et depuis Node 15 un rejet non rattrapé **tue le
      // process**. Chaque balayage du worker attrape déjà ses erreurs, mais rien ne le garantissait : il
      // suffisait que le `catch` lui-même échoue (l'alerte Telegram qui lève, par exemple) pour que le worker
      // meure en silence, à trois heures du matin, sans autre trace qu'un redémarrage.
      //
      // On journalise et on continue : une tâche périodique qui rate une passe la refera à la suivante.
      const tour = () => {
        // 🔴 GARDE DE RÉ-ENTRANCE (lot 2 du programme II). `setInterval` ne saute pas un tour parce que le
        // précédent n'est pas fini : une passe plus lente que sa cadence se superpose à elle-même, et deux
        // exemplaires du même balayage lisent puis écrivent les mêmes lignes. Un seul des dix-sept balayages
        // se protégeait. Posée ICI, elle couvre les dix-sept d'un coup, et les suivants sans qu'on y pense.
        //
        // ⚠️ Le saut est JOURNALISÉ, avec le nombre de tours sautés d'affilée. Une garde muette échangerait
        // une contention contre une invisibilité : un balayage qui déborde systématiquement ne tournerait
        // plus qu'une fois sur deux, et rien ne le dirait. Le compteur donne la gravité d'un coup d'œil.
        const sautes = enCours.get(nom);
        if (sautes !== undefined) {
          enCours.set(nom, sautes + 1);
          // eslint-disable-next-line no-console
          console.warn(`tâche « ${nom} » : passe précédente encore en cours, tour sauté (${sautes + 1} d'affilée)`);
          return;
        }
        enCours.set(nom, 0);
        void Promise.resolve()
          .then(passe)
          // eslint-disable-next-line no-console
          .catch((err: unknown) => console.error(`tâche « ${nom} » : passe en échec non rattrapée :`, err instanceof Error ? err.message : err))
          .finally(() => { enCours.delete(nom); });
      };

      // L'entrée existe DÈS MAINTENANT, minuterie ou pas : voir le commentaire de `taches`.
      const entree: { demarrage: ReturnType<typeof setTimeout> | null; intervalle: ReturnType<typeof setInterval> | null } = { demarrage: null, intervalle: null };
      taches.set(nom, entree);

      const lancer = (): void => {
        entree.demarrage = null;
        const t = setInterval(tour, intervalMs);
        t.unref();
        entree.intervalle = t;
      };

      // ⚠️ Le décalage ne lance AUCUNE passe, il ne fait que retarder le départ de la minuterie. La première
      // passe arrive donc à `décalage + intervalle`, jamais au décalage lui-même : le registre ne déclenche
      // toujours pas de passe implicite, propriété que les appelants supposent (ils gardent leur propre
      // `void passe()` de démarrage) et qu'un test garde.
      const decalage = decalageDeLissage(taches.size - 1, intervalMs);
      if (decalage === 0) {
        lancer();
      } else {
        const d = setTimeout(lancer, decalage);
        d.unref();
        entree.demarrage = d;
      }
    },

    arreterTout() {
      for (const t of taches.values()) {
        // 🔴 LES DEUX, et l'oubli du premier serait invisible en test rapide : une tâche encore dans son
        // décalage n'a pas de minuterie, donc n'arrêter que les minuteries la laisserait démarrer APRÈS la
        // fermeture, c'est-à-dire une passe qui part pendant qu'on ferme le pool. Exactement l'erreur que ce
        // registre a été écrit pour rendre impossible.
        if (t.demarrage !== null) clearTimeout(t.demarrage);
        if (t.intervalle !== null) clearInterval(t.intervalle);
      }
      taches.clear();
      // Les passes EN VOL ne sont pas interrompues (on ne sait pas les annuler), mais leur marque doit partir :
      // un registre réutilisé après un arrêt reprogrammerait des tâches que la garde croirait déjà en cours,
      // donc muettes à vie. Le cas n'existe qu'en test aujourd'hui, et c'est justement là qu'il piégerait.
      enCours.clear();
    },

    noms() {
      return [...taches.keys()];
    },
  };
}
