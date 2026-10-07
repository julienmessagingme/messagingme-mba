import type { FastifyInstance } from 'fastify';
import type { PreHandler } from '../auth/middleware';
import { espaceVerifie } from './scope';
import type { VueOffre } from '../offres/vue';

/**
 * L'OFFRE DE L'ESPACE, LUE PAR LA CONSOLE (lot 6, tâche 6) : l'offre, les fonctions ouvertes, les limites, l'usage et le
 * lien « Passer en Pro ». Tout membre peut la lire : la console grise ses menus d'après elle. La grille n'est jamais
 * recopiée dans `web/` : elle se lit ici. L'outil MCP `get_plan` rend la même vue.
 */
export interface OffreRouteDeps {
  vue(tenantId: string): Promise<VueOffre>;
}

/** `garde` : tout compte authentifié de l'espace. */
export function registerOffre(app: FastifyInstance, deps: OffreRouteDeps, garde: PreHandler): void {
  app.get('/tenants/:tenantId/offre', { preHandler: garde }, async (req, reply) => {
    return reply.code(200).send(await deps.vue(espaceVerifie(req)));
  });
}
