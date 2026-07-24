import type { PullResult, PhoneStatusPatch } from './pull';
import type { PhoneForSweepRow } from '../ops/store.pg';

/**
 * Sweeper de statut/qualité des numéros Meta (item 4.10). Le pull live du statut n'était branché QUE dans la
 * route Accueil : `quality_rating`/`status` n'étaient rafraîchis que quand un admin ouvrait la page. Ce balayage
 * périodique (worker) rafraîchit tous les numéros et ALERTE (Telegram) sur trois problèmes francs : jeton Meta
 * invalide, numéro non connecté, qualité au rouge.
 *
 * ⚠️ C'est un PALLIATIF par polling : le vrai temps réel serait le webhook `phone_number_quality_update`
 * (non câblé, cf. db/migrations/0004_phone_quality.sql). Ne pas croire le trou fermé.
 */

/** Nature du problème détecté. `null` = numéro sain (aucune alerte). */
export type PhoneProblem = 'AUTH' | 'DISCONNECTED' | 'RED';

const CONNECTED = 'CONNECTED';

/**
 * Détecte le problème d'un pull, avec les MÊMES seuils que computeAccountStatus (service.ts) :
 * - échec d'auth (token invalide) -> AUTH ; un échec transitoire (réseau, sans authError) n'alerte PAS ;
 * - numéro absent ou status != CONNECTED -> DISCONNECTED (couvre PENDING et les BAD_STATUSES) ;
 * - connecté mais qualité RED -> RED. Connecté + jaune/inconnu = pas d'alerte (hors périmètre de l'item).
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
  /** Numéros à rafraîchir (cross-tenant, borné). */
  listNumbers(): Promise<PhoneForSweepRow[]>;
  /** Pull Graph du statut (LECTURE SEULE). `null` = pull impossible (pas de token) -> on saute le numéro. */
  pull(n: PhoneForSweepRow): Promise<PullResult | null>;
  /** Persiste le patch d'un pull réussi (coalesce, saveStatus). */
  save(phoneNumberId: string, patch: PhoneStatusPatch): Promise<void>;
  /** Envoi d'alerte best-effort (ne throw JAMAIS ; la dedup est faite ICI, pas dans l'envoi). */
  alert(message: string): void;
  /**
   * État d'alerte PERSISTANT entre passages (possédé par le worker) : phoneNumberId -> dernier problème alerté.
   * Dedup par TRANSITION : on n'alerte que sur un problème NOUVEAU ou d'une nature différente ; un retour à la
   * normale ré-arme. Perdu au redémarrage du worker -> ré-alerte une fois par restart (assumé et documenté).
   */
  alertedState: Map<string, PhoneProblem>;
}

/**
 * Balaie les numéros, rafraîchit le statut persisté, alerte sur transition vers un problème. try/catch PAR numéro
 * (un numéro KO n'arrête pas le balayage, comme les autres sweepers du worker). Retourne le nombre d'alertes émises.
 */
export async function runPhoneStatusSweep(deps: PhoneStatusSweepDeps): Promise<number> {
  const numbers = await deps.listNumbers();
  let alerts = 0;
  for (const n of numbers) {
    try {
      const pull = await deps.pull(n);
      if (pull === null) continue; // pas de token -> statut sur le dernier connu, rien à faire
      if (pull.ok) {
        const { ok: _ok, ...patch } = pull;
        await deps.save(n.id, patch);
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
        // Nettoyage UNIQUEMENT sur rétablissement CONFIRMÉ (pull réussi + sain). Un échec transitoire (pull.ok=false
        // sans authError) donne aussi problem=null, mais NE prouve RIEN : effacer l'état sur ce hoquet ferait
        // ré-alerter un problème toujours présent (ex. token invalide) au passage suivant. On ne ré-arme donc que
        // sur une lecture Graph réussie qui confirme le retour à la normale.
        deps.alertedState.delete(n.id);
      }
    } catch (err) {
      // Best-effort ABSOLU : ni le pull, ni le save, ni l'alerte ne doivent tuer le worker (seul process d'envoi).
      // eslint-disable-next-line no-console
      console.error(`phone-status-sweep: échec sur le numéro ${n.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return alerts;
}
