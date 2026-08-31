/**
 * Micro-cache mémoire à durée de vie courte, avec mutualisation des appels en vol.
 *
 * Raison d'être (AUDIT-SCALE-2026-08-25.md, R7) : les compteurs de l'inbox sont relus en boucle par CHAQUE
 * onglet ouvert, sur toutes les pages. Vingt-cinq utilisateurs d'un même client posent donc vingt-cinq fois
 * la MÊME question à la base, à quelques centaines de millisecondes d'intervalle, pour un nombre qui n'a pas
 * bougé. Le cache les fait retomber sur une seule requête.
 *
 * Deux mécanismes, et les deux comptent :
 * - la DURÉE DE VIE, qui absorbe les relectures étalées dans le temps (le polling) ;
 * - la MUTUALISATION DES APPELS EN VOL, qui absorbe les relectures SIMULTANÉES. Sans elle, vingt-cinq
 *   requêtes qui arrivent dans la même milliseconde trouvent toutes le cache vide et partent toutes en base,
 *   c'est-à-dire exactement le moment où ça fait mal.
 *
 * ⚠️ PAR PROCESS. L'API et le worker ont chacun le leur, et rien ne les synchronise : ce cache convient à ce
 * qui tolère d'être en retard de quelques secondes (un compteur d'affichage), jamais à une décision.
 */

/** Ce qu'on garde par clé : une valeur datée, et/ou l'appel qui est en train de la (re)calculer. */
interface Entree<T> {
  valeur?: { v: T; expireA: number };
  enVol?: Promise<T>;
}

export interface CacheCourt<T> {
  /** Valeur en cache si elle est fraîche, sinon calcul (mutualisé si un autre appel est déjà en vol). */
  lire(cle: string, calcul: () => Promise<T>): Promise<T>;
  /** Oublie cette clé : le prochain `lire` recalcule. À appeler depuis l'écriture qui rend la valeur fausse. */
  invalider(cle: string): void;
}

/**
 * Plafond d'entrées avant balayage des périmées. Les clés sont des identifiants d'espace : leur nombre est
 * borné par la clientèle, mais un espace supprimé laisserait sinon son entrée pour la vie du process.
 */
const PLAFOND_ENTREES = 500;

export function cacheCourt<T>(ttlMs: number, maintenant: () => number = Date.now): CacheCourt<T> {
  const entrees = new Map<string, Entree<T>>();

  function balayer(now: number): void {
    for (const [cle, e] of entrees) {
      if (!e.enVol && (e.valeur === undefined || e.valeur.expireA <= now)) entrees.delete(cle);
    }
  }

  return {
    async lire(cle, calcul) {
      const now = maintenant();
      const e = entrees.get(cle);
      if (e?.valeur && e.valeur.expireA > now) return e.valeur.v;
      if (e?.enVol) return e.enVol;
      if (entrees.size >= PLAFOND_ENTREES) balayer(now);

      const entree: Entree<T> = { ...(e?.valeur ? { valeur: e.valeur } : {}) };
      // La promesse est enregistrée AVANT d'être attendue : c'est ce qui fait que les appels concurrents se
      // greffent dessus au lieu d'en lancer un chacun.
      entree.enVol = calcul().then(
        (v) => {
          // 🔴 On n'écrit QUE si personne n'a invalidé pendant le calcul. Sans cette comparaison d'identité,
          // marquer un fil comme lu pendant qu'un comptage est en vol remettrait en cache le nombre d'AVANT
          // la lecture, et la pastille resterait allumée toute la durée de vie du cache : le cache ferait
          // alors exactement le bug qu'il est censé ne pas introduire.
          if (entrees.get(cle) === entree) {
            // Date relue APRÈS le calcul : la fraîcheur se compte depuis la réponse, pas depuis la demande.
            entrees.set(cle, { valeur: { v, expireA: maintenant() + ttlMs } });
          }
          return v;
        },
        (err) => {
          // Un échec ne se met JAMAIS en cache : il serait resservi à tout le monde pendant la durée de vie.
          if (entrees.get(cle) === entree) entrees.delete(cle);
          throw err;
        },
      );
      entrees.set(cle, entree);
      return entree.enVol;
    },

    invalider(cle) {
      entrees.delete(cle);
    },
  };
}
