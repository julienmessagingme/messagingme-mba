import { BASE_QUEUES, dlqName } from '../queue/names';
import type { QueueLoadRow } from './store.pg';

export interface DlqSweepDeps {
  /** Charge de TOUTES les files (PgOpsStore.getQueueLoad). Les DLQ y sont déjà : `ALL_QUEUES` les inclut, et
   *  un job mis en DLQ y est en état `created`, donc compté dans `backlog`. Aucune requête nouvelle. */
  queueLoad: () => Promise<QueueLoadRow[]>;
  /** Émet l'alerte (Telegram côté worker). */
  alert: (msg: string) => void;
}

/** Noms des DLQ, dérivés de la source unique des files : jamais un `-dlq` réécrit à la main ici. */
const DLQ = new Set(BASE_QUEUES.map((q) => dlqName(q)));

/**
 * Surveille la profondeur des dead letter queues et alerte quand elle AUGMENTE.
 *
 * Pourquoi ce balayage existe : un job qui épuise ses rejeux part en DLQ, que RIEN ne consomme (c'est un dépôt
 * inspecté par /ops, cf. `src/queue/names.ts`). Personne n'était prévenu. Constaté en production le
 * 2026-08-25 : un message client entrant y dormait depuis le 2026-08-17, perdu en silence par une migration
 * manquante. À 100 tenants, le même incident draine l'entrant de tout le parc sans que personne ne l'apprenne.
 *
 * ⚠️ ALERTE SUR LA HAUSSE, PAS SUR L'ÉTAT. Réutiliser tel quel l'alerte throttlée du worker (5 min) enverrait
 * un Telegram toutes les 5 minutes À VIE tant qu'un job reste en DLQ, puisque la condition est PERMANENTE :
 * personne ne vide ces files. On ne signale donc qu'un franchissement vers le haut. La conséquence assumée est
 * qu'une DLQ vidée puis re-remplie au même niveau ne réalerte pas tant que le compteur n'a pas été vu plus
 * bas ; c'est le bon compromis contre le harcèlement, et /ops montre l'état exact à tout moment.
 *
 * L'état vit en mémoire du process : un redémarrage réalerte une fois sur une DLQ déjà pleine. C'est voulu,
 * c'est même utile après un déploiement.
 */
export function creerDlqSweep(deps: DlqSweepDeps): () => Promise<number> {
  const dejaAlerte = new Map<string, number>();

  return async function dlqSweep(): Promise<number> {
    const charge = await deps.queueLoad();
    let enHausse = 0;
    for (const ligne of charge) {
      // Le filtre vit ICI, pas en SQL : c'est ce qui rend testable la garde « ne pas alerter sur une file saine ».
      if (!DLQ.has(ligne.queue)) continue;
      const profondeur = ligne.backlog + ligne.active + ligne.failed;
      const vu = dejaAlerte.get(ligne.queue) ?? 0;
      if (profondeur > vu) {
        dejaAlerte.set(ligne.queue, profondeur);
        enHausse += 1;
        deps.alert(`${ligne.queue} : ${profondeur} job(s) en échec définitif, non rejoués (voir /ops)`);
      } else if (profondeur < vu) {
        // Redescente (purge de rétention pg-boss, ou rejeu manuel) : on réarme, sinon une nouvelle vague au
        // même niveau resterait muette pour toujours.
        dejaAlerte.set(ligne.queue, profondeur);
      }
    }
    return enHausse;
  };
}
