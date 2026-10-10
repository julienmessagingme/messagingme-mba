import type { AuditAction } from './store.pg';
import { tenter } from '../lib/tenter';

/**
 * Écriture du journal, telle qu'une route la reçoit en dépendance. Requise : les tests qui ne l'observent pas passent
 * `journalMuet`. (L'ancienne phrase disait « optionnelle », elle ne l'est plus depuis les dépendances requises.)
 * l'action métier se déroule sans trace.
 */
export type AuditSink = (
  tenantId: string,
  actor: { userId: string | null; email: string | null },
  action: AuditAction,
  target: { kind: string; id: string },
  detail?: Record<string, unknown>,
) => Promise<void>;

/**
 * Ce qu'un geste d'exploitation laisse dans l'espace qu'il touche : l'exploitant (`par`, son adresse) pour acteur,
 * l'espace pour cible. Best-effort comme `makeJournal` : le geste a eu lieu, un journal en panne ne doit pas faire croire
 * le contraire.
 */
export type TraceOps = (tenantId: string, par: string, action: AuditAction, detail?: Record<string, unknown>) => Promise<void>;

export function makeTraceOps(audit: AuditSink): TraceOps {
  return async (tenantId, par, action, detail = {}) => {
    await tenter('audit ignoré:', () => audit(tenantId, { userId: null, email: par }, action, { kind: 'tenant', id: tenantId }, detail));
  };
}

/** Ce qu'une route appelle. L'acteur est déduit de la requête, l'appelant n'a pas à le construire. */
export type Journal = (
  tenantId: string,
  req: { auth?: { userId: string; viaLien?: true } },
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
    // Une écriture faite par le lien de connexion du numéro que donne Claude Code (lot 3c, garde `adminOuLien`) le dit.
    const detailFinal = req.auth?.viaLien === true ? { ...detail, via: 'lien_claude_code' } : detail;
    await tenter('audit ignoré:', () => audit(tenantId, { userId: req.auth?.userId ?? null, email: null }, action, target, detailFinal));
  };
}
