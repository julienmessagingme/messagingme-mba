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

export function registreDeTaches(): RegistreDeTaches {
  const minuteries = new Map<string, ReturnType<typeof setInterval>>();
  /** Les passes EN COURS, par nom, avec le nombre de tours sautés d'affilée. */
  const enCours = new Map<string, number>();

  return {
    programmer(nom, intervalMs, passe) {
      if (minuteries.has(nom)) {
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
      const t = setInterval(() => {
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
      }, intervalMs);
      t.unref();
      minuteries.set(nom, t);
    },

    arreterTout() {
      for (const t of minuteries.values()) clearInterval(t);
      minuteries.clear();
      // Les passes EN VOL ne sont pas interrompues (on ne sait pas les annuler), mais leur marque doit partir :
      // un registre réutilisé après un arrêt reprogrammerait des tâches que la garde croirait déjà en cours,
      // donc muettes à vie. Le cas n'existe qu'en test aujourd'hui, et c'est justement là qu'il piégerait.
      enCours.clear();
    },

    noms() {
      return [...minuteries.keys()];
    },
  };
}
