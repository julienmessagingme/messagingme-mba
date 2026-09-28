/**
 * Les travaux qu'une réponse HTTP laisse derrière elle (un envoi du relais de l'agent de Meta continue une quinzaine
 * de secondes après avoir répondu). L'arrêt du processus les attend, borné, AVANT de fermer la file et le pool dont
 * ils ont besoin : sans ce suivi, l'arrêt d'une copie de l'API couperait l'envoi en route, alors que l'agent de Meta
 * a déjà lu « c'est parti ».
 */
export interface TravauxEnVol {
  /** Suit ce travail jusqu'à sa fin, quelle qu'elle soit. Rend la même promesse, inchangée. */
  suivre<T>(travail: Promise<T>): Promise<T>;
  /**
   * Attend la fin de tous les travaux suivis, y compris ceux ajoutés pendant l'attente, au plus `borneMs`. Rend le
   * nombre de travaux encore en vol à la fin de l'attente (0 = tout est fini). Ne lève jamais.
   */
  attendre(borneMs: number): Promise<number>;
}

export function creerTravauxEnVol(): TravauxEnVol {
  const enVol = new Set<Promise<void>>();
  return {
    suivre(travail) {
      // Le suivi ne rejette jamais : un travail en échec est fini, et l'erreur reste à celui qui tient `travail`.
      const suivi: Promise<void> = travail.then(() => {}, () => {}).then(() => { enVol.delete(suivi); });
      enVol.add(suivi);
      return travail;
    },
    async attendre(borneMs) {
      const echeance = Date.now() + borneMs;
      while (enVol.size > 0) {
        const reste = echeance - Date.now();
        if (reste <= 0) break;
        let minuterie: ReturnType<typeof setTimeout> | undefined;
        const delai = new Promise<void>((r) => { minuterie = setTimeout(r, reste); });
        await Promise.race([Promise.all([...enVol]), delai]);
        clearTimeout(minuterie);
      }
      return enVol.size;
    },
  };
}
