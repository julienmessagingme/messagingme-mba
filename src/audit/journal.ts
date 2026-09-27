import type { AuditAction } from './store.pg';
import { tenter } from '../lib/tenter';

/**
 * Écriture du journal, telle qu'une route la reçoit en dépendance. Optionnelle : absente (câblages de test),
 * l'action métier se déroule sans trace.
 */
export type AuditSink = (
  tenantId: string,
  actor: { userId: string | null; email: string | null },
  action: AuditAction,
  target: { kind: string; id: string },
  detail?: Record<string, unknown>,
) => Promise<void>;

/** Ce qu'une route appelle. L'acteur est déduit de la requête, l'appelant n'a pas à le construire. */
export type Journal = (
  tenantId: string,
  req: { auth?: { userId: string } },
  action: AuditAction,
  target: { kind: string; id: string },
  detail?: Record<string, unknown>,
) => Promise<void>;

/**
 * Fabrique le journaliseur d'une route. Best-effort par construction : une panne d'écriture du journal ne doit pas
 * empêcher un client d'exercer son droit à l'effacement. L'échec reste visible en console.
 * L'acteur ne porte que l'identifiant ; l'email est résolu au câblage et dénormalisé, lisible après un départ.
 */
export function makeJournal(audit?: AuditSink): Journal {
  return async (tenantId, req, action, target, detail = {}) => {
    if (!audit) return;
    await tenter('audit ignoré:', () => audit(tenantId, { userId: req.auth?.userId ?? null, email: null }, action, target, detail));
  };
}
