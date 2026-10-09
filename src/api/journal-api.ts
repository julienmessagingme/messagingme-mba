import type { FastifyRequest } from 'fastify';
import type { AuditAction } from '../audit/store.pg';
import type { AuditSink } from '../audit/journal';
import { tenter } from '../lib/tenter';
import { cleIdDe } from './usage-guard';

/**
 * LE JOURNAL D'UNE ÉCRITURE FAITE PAR L'API PUBLIQUE (lot 13, domaines 4 et 5).
 *
 * 🔴 Pas `makeJournal` : derrière une clé, `req.auth.userId` vaut `apikey:<id>`, que la lecture de l'email de l'acteur
 * (`getSessionUser`, sur une colonne uuid) et `audit_log.actor_user_id` (uuid) refusent. L'écriture échouait, avalée
 * par `tenter`, et rien n'arrivait dans Sécurité > Journal. Comme le consentement (`src/api/consentement.ts`) : une clé
 * n'est pas un compte, l'acteur reste vide ; une personne connectée par OAuth signe ; la clé ou l'autorisation est
 * dans le détail, avec `via: 'api'`. Best-effort, comme tout le journal.
 */
export type JournalApi = (
  tenantId: string,
  req: FastifyRequest,
  action: AuditAction,
  cible: { kind: string; id: string },
  detail?: Record<string, unknown>,
) => Promise<void>;

export function journalDeLApi(audit: AuditSink): JournalApi {
  return async (tenantId, req, action, cible, detail = {}) => {
    await tenter('audit ignoré:', () => audit(
      tenantId,
      { userId: req.apiPersonne?.userId ?? null, email: null },
      action,
      cible,
      { ...detail, via: 'api', acces: cleIdDe(req) },
    ));
  };
}
