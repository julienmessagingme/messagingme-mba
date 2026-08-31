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
        void Promise.resolve()
          .then(passe)
          // eslint-disable-next-line no-console
          .catch((err: unknown) => console.error(`tâche « ${nom} » : passe en échec non rattrapée :`, err instanceof Error ? err.message : err));
      }, intervalMs);
      t.unref();
      minuteries.set(nom, t);
    },

    arreterTout() {
      for (const t of minuteries.values()) clearInterval(t);
      minuteries.clear();
    },

    noms() {
      return [...minuteries.keys()];
    },
  };
}
