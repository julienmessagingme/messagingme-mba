/**
 * LA DURÉE ET LES LIGNES DES TÂCHES DE FOND (migration 0207, audit de performance du 2026-10-02, § 11).
 *
 * Le registre des tâches (`src/worker/taches.ts`) appelle `noter` à la fin de CHAQUE passe : toutes les tâches sont
 * mesurées, y compris celles qu'on ajoutera. Le worker vide l'agrégat chaque minute vers `taches_mesures`, par
 * heure, et `/ops` le relit. Même modèle que la latence HTTP (`latence-http.ts`) : une mesure en mémoire, un vidage
 * au mieux, une écriture ratée réinjectée.
 */

/** Ce qu'une tâche a fait dans une fenêtre, pour un processus. `lignes` est `null` tant qu'aucune passe n'en rend. */
export interface LigneTache {
  tache: string;
  passes: number;
  echecs: number;
  /** Tours sautés parce que la passe précédente n'était pas finie : la trace d'une passe bloquée ou trop longue. */
  sautees: number;
  sommeMs: number;
  maxMs: number;
  lignes: number | null;
  maxLignes: number | null;
}

/** Ce que `/ops` affiche : une ligne par processus et par tâche, sur la fenêtre demandée. */
export interface TacheMesureRow extends LigneTache {
  process: string;
  /** Début de la dernière heure où la tâche a tourné. */
  derniere: string;
}

/** Au-delà de sept jours, on efface : `/ops` regarde 24 h, la semaine sert à comparer à la veille. */
export const RETENTION_TACHES_JOURS = 7;

/**
 * Une passe plus longue que ceci est signalée en rouge dans `/ops` : c'est le déclencheur de l'audit pour les
 * agrégats d'analyse (§ 12, P2). Il vaut pour toutes les tâches, aucune n'ayant de raison de durer davantage. Un
 * échec ou un tour sauté passent aussi en rouge.
 */
export const SEUIL_TACHE_LENTE_MS = 5 * 60_000;

export class MesureTaches {
  private lignes = new Map<string, LigneTache>();

  /**
   * Une passe terminée. `lignes` est ce que la passe a rendu quand elle rend un nombre (lignes écrites ou
   * effacées), `null` sinon : une tâche qui ne compte rien n'affiche pas zéro.
   */
  noter(tache: string, dureeMs: number, lignes: number | null, ok: boolean): void {
    const duree = Number.isFinite(dureeMs) && dureeMs > 0 ? dureeMs : 0;
    const l = this.ligneDe(tache);
    l.passes += 1;
    if (!ok) l.echecs += 1;
    l.sommeMs += duree;
    if (duree > l.maxMs) l.maxMs = duree;
    if (lignes !== null && Number.isFinite(lignes) && lignes >= 0) {
      l.lignes = (l.lignes ?? 0) + lignes;
      l.maxLignes = Math.max(l.maxLignes ?? 0, lignes);
    }
  }

  /** Un tour sauté : la passe précédente tourne encore. Une passe bloquée n'a pas d'autre trace, elle ne finit jamais. */
  noterSaut(tache: string): void {
    this.ligneDe(tache).sautees += 1;
  }

  private ligneDe(tache: string): LigneTache {
    let l = this.lignes.get(tache);
    if (!l) {
      l = { tache, passes: 0, echecs: 0, sautees: 0, sommeMs: 0, maxMs: 0, lignes: null, maxLignes: null };
      this.lignes.set(tache, l);
    }
    return l;
  }

  /** Rend ce qui s'est accumulé et repart à vide (boucle à un seul fil : rien ne se perd entre les deux). */
  vider(): LigneTache[] {
    const lignes = [...this.lignes.values()];
    this.lignes = new Map();
    return lignes;
  }

  /** Remet des lignes qu'on n'a pas pu écrire, fusionnées avec ce qui s'est accumulé entre-temps. */
  reinjecter(lignes: LigneTache[]): void {
    for (const r of lignes) {
      const l = this.ligneDe(r.tache);
      l.passes += r.passes;
      l.echecs += r.echecs;
      l.sautees += r.sautees;
      l.sommeMs += r.sommeMs;
      if (r.maxMs > l.maxMs) l.maxMs = r.maxMs;
      if (r.lignes !== null) l.lignes = (l.lignes ?? 0) + r.lignes;
      if (r.maxLignes !== null) l.maxLignes = Math.max(l.maxLignes ?? 0, r.maxLignes);
    }
  }
}

/** Le nombre que rend une passe, s'il en rend un : `void`, `undefined` ou autre chose donnent `null`. */
export function lignesRendues(resultat: unknown): number | null {
  return typeof resultat === 'number' && Number.isFinite(resultat) ? resultat : null;
}
