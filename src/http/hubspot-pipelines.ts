import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { HubspotServiceError } from '../crm/hubspot-service';
import type { HubspotDealPipeline } from '../crm/hubspot-service';
import { espaceVerifie } from './scope';

export interface HubspotPipelinesRouteDeps {
  /**
   * Pipelines de deals du portail du tenant, via le canal service signé du connecteur. Lève si le tenant n'a pas
   * de portail lié (`tenant_not_connected`), ce que la route traduit en `connected:false`.
   */
  fetchDealStages(tenantId: string): Promise<HubspotDealPipeline[]>;
}

/** Le connecteur répond 404 `tenant_not_connected` quand aucun portail n'est lié : ce n'est pas une panne. */
const estNonConnecte = (err: unknown): boolean => err instanceof HubspotServiceError && err.status === 404;

/**
 * Étapes de deal du portail HubSpot, pour configurer une automation « étape de deal » par libellés. Lecture seule,
 * admin. Non gardée par le réglage « Campagnes via données HubSpot », qui gouverne l'import de contacts : une
 * automation d'étape n'importe ni n'envoie rien. Portail non lié : 200 `{connected:false}` ; toute autre panne remonte.
 */
export function registerHubspotPipelines(app: FastifyInstance, deps: HubspotPipelinesRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/hubspot/deal-stages', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    try {
      return reply.code(200).send({ connected: true, pipelines: await deps.fetchDealStages(tenant) });
    } catch (err) {
      if (estNonConnecte(err)) return reply.code(200).send({ connected: false, pipelines: [] });
      throw err;
    }
  });
}
