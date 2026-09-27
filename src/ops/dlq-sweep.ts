import { BASE_QUEUES, dlqName } from '../queue/names';
import type { QueueLoadRow } from './store.pg';

export interface DlqSweepDeps {
  /** Charge de toutes les files (`getQueueLoad`) : les DLQ y sont, et un job mis en DLQ y compte dans `backlog`. */
  queueLoad: () => Promise<QueueLoadRow[]>;
  /** Émet l'alerte. `queue` est passé à part pour servir de clé de throttle : le redécouper depuis `msg`
   *  casserait à la première reformulation du message. */
  alert: (queue: string, msg: string) => void;
}

/** Noms des DLQ, dérivés de la source unique des files : jamais un `-dlq` réécrit à la main ici. */
const DLQ = new Set(BASE_QUEUES.map((q) => dlqName(q)));

/**
 * Surveille la profondeur des dead letter queues et alerte quand elle augmente. Rien ne consomme une DLQ (c'est
 * un dépôt inspecté par /ops) : sans ce balayage, un message entrant peut y dormir sans que personne l'apprenne.
 *
 * On alerte sur la hausse, pas sur l'état : la condition est permanente tant que personne ne vide la file, et
 * une alerte throttlée partirait toutes les 5 minutes à vie. L'état vit en mémoire : un redémarrage réalerte
 * une fois sur une DLQ déjà pleine.
 */
export function creerDlqSweep(deps: DlqSweepDeps): () => Promise<number> {
  const dejaAlerte = new Map<string, number>();
  let enCours = false;

  return async function dlqSweep(): Promise<number> {
    // Garde de ré-entrance : `setInterval` n'attend pas la passe précédente, et deux passes qui se chevauchent
    // alerteraient deux fois sur la même hausse. Elle vit avec le compteur qu'elle protège.
    if (enCours) return 0;
    enCours = true;
    try {
      return await passe();
    } finally {
      enCours = false;
    }
  };

  async function passe(): Promise<number> {
    const charge = await deps.queueLoad();
    let enHausse = 0;
    for (const ligne of charge) {
      // Filtre en code et non en SQL : c'est ce qui rend testable « ne pas alerter sur une file saine ».
      if (!DLQ.has(ligne.queue)) continue;
      const profondeur = ligne.backlog + ligne.active + ligne.failed;
      const vu = dejaAlerte.get(ligne.queue) ?? 0;
      if (profondeur > vu) {
        dejaAlerte.set(ligne.queue, profondeur);
        enHausse += 1;
        deps.alert(ligne.queue, `${ligne.queue} : ${profondeur} job(s) en échec définitif, non rejoués (voir /ops)`);
      } else if (profondeur < vu) {
        // Redescente (purge de rétention pg-boss, ou rejeu manuel) : on réarme, sinon une nouvelle vague au
        // même niveau resterait muette pour toujours.
        dejaAlerte.set(ligne.queue, profondeur);
      }
    }
    return enHausse;
  }
}
