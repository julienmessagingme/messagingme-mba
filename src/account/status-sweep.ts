import type { PullResult, PhoneStatusPatch } from './pull';
import type { PhoneForSweepRow } from '../ops/store.pg';
import { messageDe } from '../lib/erreur';

/**
 * Balayage périodique du statut et de la qualité des numéros Meta : rafraîchit tous les numéros et alerte (Telegram)
 * sur trois problèmes francs, jeton invalide, numéro non connecté, qualité au rouge. C'est un palliatif par
 * sondage : le temps réel serait le webhook `phone_number_quality_update`, non câblé.
 */

/** Nature du problème détecté. `null` = numéro sain (aucune alerte). */
export type PhoneProblem = 'AUTH' | 'DISCONNECTED' | 'RED';

const CONNECTED = 'CONNECTED';

/**
 * Le problème d'un pull, avec les mêmes seuils que computeAccountStatus : échec d'auth -> AUTH (un échec
 * transitoire n'alerte pas) ; statut absent ou autre que CONNECTED -> DISCONNECTED ; qualité RED -> RED.
 */
export function phoneProblem(pull: PullResult): PhoneProblem | null {
  if (!pull.ok) return pull.authError ? 'AUTH' : null;
  const status = pull.status;
  if (!status || status.toUpperCase() !== CONNECTED) return 'DISCONNECTED';
  if ((pull.qualityRating ?? '').toUpperCase() === 'RED') return 'RED';
  return null;
}

/** Message d'alerte lisible. `n` = ligne persistée (identité), `pull` = état frais. */
function describe(n: PhoneForSweepRow, problem: PhoneProblem, pull: PullResult): string {
  const label = (pull.ok && pull.displayPhoneNumber) || n.id;
  if (problem === 'AUTH') return `⚠️ Numéro ${label} : jeton Meta invalide/expiré (le pull du statut échoue en auth).`;
  if (problem === 'RED') return `⚠️ Numéro ${label} : qualité au ROUGE (risque de restriction Meta).`;
  const st = pull.ok ? pull.status : undefined;
  return `⚠️ Numéro ${label} : statut Meta « ${st ?? 'inconnu'} » (≠ CONNECTED).`;
}

export interface PhoneStatusSweepDeps {
  /** Numéros à rafraîchir (tous espaces, borné). */
  ops: { listNumbersForStatusSweep(): Promise<PhoneForSweepRow[]> };
  /** Pull Graph du statut, en lecture seule. `null` = pas de token : on saute le numéro. */
  pull(n: PhoneForSweepRow): Promise<PullResult | null>;
  /** Persiste le patch d'un pull réussi (coalesce). */
  statuts: { saveStatus(phoneNumberId: string, patch: PhoneStatusPatch): Promise<void> };
  /** Envoi d'alerte best-effort, qui ne lève jamais ; la déduplication est faite ici. */
  alert(message: string): void;
  /**
   * Dernier problème alerté par numéro, tenu par le worker entre deux passages. On n'alerte que sur un problème
   * nouveau ou d'une autre nature ; un retour à la normale ré-arme. Perdu au redémarrage : une ré-alerte, assumée.
   */
  alertedState: Map<string, PhoneProblem>;
}

/**
 * Balaie les numéros, persiste le statut, alerte sur transition vers un problème. try/catch par numéro : un numéro
 * en échec n'arrête pas le balayage. Rend le nombre d'alertes émises.
 */
export async function runPhoneStatusSweep(deps: PhoneStatusSweepDeps): Promise<number> {
  const numbers = await deps.ops.listNumbersForStatusSweep();
  let alerts = 0;
  for (const n of numbers) {
    try {
      const pull = await deps.pull(n);
      if (pull === null) continue; // pas de token : statut sur le dernier connu
      if (pull.ok) {
        const { ok: _ok, ...patch } = pull;
        await deps.statuts.saveStatus(n.id, patch);
      }
      const problem = phoneProblem(pull);
      const prev = deps.alertedState.get(n.id);
      if (problem) {
        if (prev !== problem) {
          deps.alert(describe(n, problem, pull));
          deps.alertedState.set(n.id, problem);
          alerts += 1;
        }
      } else if (pull.ok && prev !== undefined) {
        // On ne ré-arme que sur un rétablissement confirmé par une lecture réussie : un échec transitoire donne aussi
        // problem=null, et effacer l'état ferait ré-alerter un problème toujours présent.
        deps.alertedState.delete(n.id);
      }
    } catch (err) {
      // Rien ici ne doit tuer le worker, seul process d'envoi.
      // eslint-disable-next-line no-console
      console.error(`phone-status-sweep: échec sur le numéro ${n.id}:`, messageDe(err));
    }
  }
  return alerts;
}
