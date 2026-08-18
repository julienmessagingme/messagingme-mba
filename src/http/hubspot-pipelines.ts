import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { HubspotServiceError } from '../crm/hubspot-import';
import type { HubspotDealPipeline } from '../crm/hubspot-import';
import { scopeTenant } from './scope';

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
 * Étapes de deal du portail HubSpot, pour configurer une automation « étape de deal » avec des LIBELLÉS plutôt
 * qu'avec des identifiants opaques. Lecture seule, admin-only (comme le reste de la configuration).
 *
 * Volontairement NON gardée par le réglage « Campagnes via données HubSpot » : ce réglage gouverne l'import de
 * contacts depuis les listes, un tout autre pouvoir. Une automation d'étape n'importe personne et n'envoie rien
 * par elle-même, et la brancher sur ce réglage rendrait le menu vide pour un portail parfaitement connecté.
 *
 * Un portail non lié rend `{connected:false}` en 200 : l'écran affiche « connecte HubSpot d'abord », pas une
 * erreur rouge. Toute autre panne remonte (500), on ne fait pas passer une indisponibilité pour une absence.
 */
export function registerHubspotPipelines(app: FastifyInstance, deps: HubspotPipelinesRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.get('/tenants/:tenantId/hubspot/deal-stages', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    try {
      return reply.code(200).send({ connected: true, pipelines: await deps.fetchDealStages(tenant) });
    } catch (err) {
      if (estNonConnecte(err)) return reply.code(200).send({ connected: false, pipelines: [] });
      throw err;
    }
  });
}
