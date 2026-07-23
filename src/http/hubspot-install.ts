import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { buildInstallUrl } from '../hubspot/install-link';

export interface HubspotInstallRouteDeps {
  /** Origine publique du connecteur (HUBSPOT_CONNECTOR_PUBLIC_URL). Vide -> 503. */
  connectorPublicUrl: string;
  /** Secret partagé (HUBSPOT_SERVICE_SECRET == SERVICE_SECRET). Vide -> 503. */
  serviceSecret: string;
  /** now() injectable pour les tests. */
  now?: () => number;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

/** Grants optionnels autorisés (whitelist stricte : jamais un grant arbitraire venu du corps de la requête). */
const ALLOWED_GRANTS = new Set(['lists']);

/**
 * `POST /tenants/:tenantId/hubspot/install-link` (admin-only). Émet un lien d'install/re-consentement HubSpot portant
 * un JETON SIGNÉ (le tenant est dans la signature, plus dans un `?tenant=` en clair forgeable). Le front ouvre l'URL
 * renvoyée. Le tenant vient du JWT (scopeTenant), jamais du corps. Body optionnel : `{ grant?: 'lists' }`.
 */
export function registerHubspotInstall(app: FastifyInstance, deps: HubspotInstallRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};
  const now = deps.now ?? (() => Date.now());

  app.post('/tenants/:tenantId/hubspot/install-link', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });

    const b = (req.body ?? {}) as { grant?: unknown };
    let grant: string | undefined;
    if (b.grant !== undefined) {
      if (typeof b.grant !== 'string' || !ALLOWED_GRANTS.has(b.grant)) {
        return reply.code(400).send({ error: 'grant invalide' });
      }
      grant = b.grant;
    }

    const installUrl = buildInstallUrl(deps.connectorPublicUrl, deps.serviceSecret, now(), tenant, grant);
    if (!installUrl) {
      return reply.code(503).send({ error: 'connecteur HubSpot non configuré (URL publique ou secret manquant)' });
    }
    return reply.code(200).send({ installUrl });
  });
}
