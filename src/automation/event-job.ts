import type { AutomationEvent } from './match';

/**
 * File `automation-event` : le pont entre les processus (E.2).
 *
 * Pourquoi une file. Un tag peut être posé depuis l'API (édition d'une fiche) alors que SEUL le worker sait
 * démarrer un scénario (c'est lui qui tient l'exécuteur, les clients Meta, les stores de runs). L'API publie
 * donc un événement, le worker le consomme. Bénéfice second : durable et rejouable, donc un tag posé pendant
 * un redémarrage du worker n'est pas perdu.
 *
 * ⚠️ Émission volontairement limitée aux chemins UNITAIRES (bloc Action d'un scénario, édition d'une fiche).
 * Un import CSV ou une action en masse n'émettent PAS : poser un tag sur 5 000 contacts déclencherait 5 000
 * scénarios, donc 5 000 messages facturés, sans que personne l'ait demandé. Pour toucher une liste, l'outil
 * prévu est la campagne, qui a ses propres garde-fous (cadence, fenêtre, quality gate).
 */

/** Ce qui transite dans la file. `tenantId` porté explicitement : le worker ne le déduit de rien d'autre. */
export interface AutomationEventJob {
  tenantId: string;
  event: AutomationEvent;
}

export const AUTOMATION_EVENT_QUEUE = 'automation-event';

/**
 * Coerce un payload de file (JSON opaque, potentiellement d'une version antérieure du code) en job valide.
 * null = payload inexploitable -> le worker l'ignore proprement au lieu de planter la file.
 */
export function parseAutomationEventJob(raw: unknown): AutomationEventJob | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const j = raw as { tenantId?: unknown; event?: unknown };
  if (typeof j.tenantId !== 'string' || j.tenantId === '') return null;
  if (!j.event || typeof j.event !== 'object') return null;
  const e = j.event as Record<string, unknown>;
  const waId = typeof e.waId === 'string' ? e.waId : '';
  if (waId === '') return null;
  if (e.kind === 'tag_added') {
    const tag = typeof e.tag === 'string' ? e.tag : '';
    return tag === '' ? null : { tenantId: j.tenantId, event: { kind: 'tag_added', waId, tag } };
  }
  if (e.kind === 'analysis') {
    return {
      tenantId: j.tenantId,
      event: { kind: 'analysis', waId, sentiment: typeof e.sentiment === 'string' ? e.sentiment : '', resolved: e.resolved === true },
    };
  }
  // `message` n'a rien à faire dans la file : il est traité en direct dans le webhook, où le contexte
  // (isNewContact, consommation du message) n'existe que le temps du job. L'accepter ici ouvrirait un second
  // chemin de déclenchement au comportement subtilement différent.
  return null;
}
