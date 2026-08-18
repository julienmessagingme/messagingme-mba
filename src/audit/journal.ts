import type { AuditAction } from './store.pg';

/**
 * Écriture du journal, telle qu'une route la reçoit en dépendance. OPTIONNELLE partout : absente, l'action
 * métier se déroule sans trace (c'est le cas des câblages de test, qui ne montent pas de base).
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
 * Fabrique le journaliseur d'une route.
 *
 * BEST-EFFORT PAR CONSTRUCTION, et ce n'est pas de la négligence : l'inverse voudrait dire qu'une panne
 * d'écriture de log empêche un client d'exercer son droit à l'effacement. L'échec reste visible en console,
 * sans quoi un journal muet serait indétectable.
 *
 * L'acteur ne porte que l'identifiant : l'email est résolu au câblage, où il est DÉNORMALISÉ dans le journal
 * pour rester lisible même après le départ du collaborateur.
 */
export function makeJournal(audit?: AuditSink): Journal {
  return async (tenantId, req, action, target, detail = {}) => {
    if (!audit) return;
    try {
      await audit(tenantId, { userId: req.auth?.userId ?? null, email: null }, action, target, detail);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('audit ignoré:', err instanceof Error ? err.message : err);
    }
  };
}
