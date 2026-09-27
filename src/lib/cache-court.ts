/**
 * Micro-cache mémoire à durée de vie courte, avec mutualisation des appels en vol.
 *
 * Les compteurs de l'inbox sont relus en boucle par chaque onglet ouvert : la durée de vie absorbe les
 * relectures étalées (le polling), la mutualisation absorbe les relectures simultanées, qui trouveraient sinon
 * toutes le cache vide et partiraient toutes en base.
 *
 * Par process : l'API et le worker ont chacun le leur, sans synchronisation. Il convient à ce qui tolère
 * quelques secondes de retard (un compteur d'affichage), jamais à une décision.
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
  /**
   * Invalide toutes les entrées dont la clé commence par ce préfixe : une clé peut porter plus que l'espace (la
   * pastille de non-lus porte l'utilisateur), et une invalidation par clé exacte la manquerait.
   */
  invaliderPrefixe(prefixe: string): void;
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
      // La promesse est enregistrée avant d'être attendue : les appels concurrents s'y greffent au lieu d'en lancer
      // un chacun.
      entree.enVol = calcul().then(
        (v) => {
          // On n'écrit que si personne n'a invalidé pendant le calcul : sinon un fil marqué lu pendant un comptage en
          // vol remettrait en cache le nombre d'avant, et la pastille resterait allumée toute la durée de vie.
          if (entrees.get(cle) === entree) {
            // Date relue après le calcul : la fraîcheur se compte depuis la réponse, pas depuis la demande.
            entrees.set(cle, { valeur: { v, expireA: maintenant() + ttlMs } });
          }
          return v;
        },
        (err) => {
          // Un échec ne se met jamais en cache : il serait resservi à tout le monde pendant la durée de vie.
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
    invaliderPrefixe(prefixe) {
      // Un balayage complet : les entrées sont bornées par `PLAFOND_ENTREES`, et l'invalidation est un
      // geste rare (une écriture dans l'inbox), pas un chemin chaud.
      for (const cle of entrees.keys()) if (cle.startsWith(prefixe)) entrees.delete(cle);
    },
  };
}
