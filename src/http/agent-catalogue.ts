import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { OutilBibliotheque } from '../agent/catalog';
import { espaceVerifie } from './scope';

/**
 * La bibliothèque d'outils d'un espace (lecture seule) : les connecteurs que les agents IA peuvent brancher.
 * Module distinct de `agent-tools.ts`, qui porte le consentement d'un agent : deux objets, deux jeux de gardes.
 * Les outils de l'agent de Meta vivent dans `mba-outils.ts`. Isolation par `scopeTenant` seul : la bibliothèque
 * appartient à l'espace.
 */
export interface AgentCatalogueRouteDeps {
  listCatalogue(tenantId: string): Promise<OutilBibliotheque[]>;
}

export function registerAgentCatalogue(app: FastifyInstance, deps: AgentCatalogueRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const base = '/tenants/:tenantId/agent-tools';

  app.get(base, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ outils: await deps.listCatalogue(tenant) });
  });
}
