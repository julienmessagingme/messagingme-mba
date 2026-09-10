import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { OutilBibliotheque } from '../agent/catalog';
import { scopeTenant, estUuid } from './scope';

/**
 * La BIBLIOTHÈQUE d'outils d'un espace (migration 0127).
 *
 * 🔴 POURQUOI UN MODULE À PART DE `agent-tools.ts`. Les deux écrans ne parlent pas du même objet : celui-ci
 * montre les DÉFINITIONS de l'espace, l'autre le CONSENTEMENT d'un agent. Les fondre ferait un module dont
 * la moitié des gardes ne s'appliquent qu'à la moitié des routes, et c'est ainsi qu'une garde finit par
 * manquer là où elle comptait. Le découpage suit l'objet, pas la couche technique.
 *
 * ⚠️ Son isolation passe par `scopeTenant`, pas par un numéro ni un agent dans l'URL : la bibliothèque est
 * une propriété de l'ESPACE, et c'est exactement ce que le lot 1 vient d'établir.
 */

export interface AgentCatalogueRouteDeps {
  listCatalogue(tenantId: string): Promise<OutilBibliotheque[]>;
  supprimerDefinition(tenantId: string, outilId: string): Promise<'ok' | 'rattachee' | 'introuvable'>;
}

export function registerAgentCatalogue(app: FastifyInstance, deps: AgentCatalogueRouteDeps, guard?: Guard): void {
  // Même forme que `registerAgentTools` : le garde est OPTIONNEL pour que les tests montent le module avec
  // des dépendances minimales. En production il est TOUJOURS câblé, et `buildServer` refuse de démarrer si
  // un module à routes `:tenantId` est monté sans authentification.
  const opts = guard ? { preHandler: guard } : {};
  const base = '/tenants/:tenantId/agent-tools';

  app.get(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    return reply.code(200).send({ outils: await deps.listCatalogue(tenant) });
  });

  /**
   * Supprime une DÉFINITION, donc pour TOUT LE MONDE.
   *
   * 🔴 REFUSE en 409 tant qu'un consommateur y est rattaché, MÊME INACTIF. La contrainte de la migration
   * 0127 est en `on delete cascade` : sans ce refus applicatif, la suppression emporterait en silence le
   * consentement d'agents qu'on ne regardait pas, et l'écran annoncerait un succès.
   *
   * ⚠️ 409 et pas 500 : Cloudflare remplace le corps de toute réponse 5xx par sa page d'erreur, donc un
   * message destiné à l'utilisateur n'arriverait jamais.
   */
  app.delete(`${base}/:outilId`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    const { outilId } = req.params as { outilId: string };
    if (!estUuid(outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    const verdict = await deps.supprimerDefinition(tenant, outilId);
    if (verdict === 'introuvable') return reply.code(404).send({ error: 'outil introuvable' });
    if (verdict === 'rattachee') {
      return reply.code(409).send({
        error: 'Cet outil est encore utilisé par au moins un agent. Retirez-le de chaque agent avant de le supprimer de l’espace.',
      });
    }
    return reply.code(204).send();
  });
}
