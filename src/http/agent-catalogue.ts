import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { OutilBibliotheque } from '../agent/catalog';
import { scopeTenant } from './scope';

/**
 * La BIBLIOTHÈQUE d'outils d'un espace (migration 0127) : les connecteurs que les agents IA peuvent brancher.
 *
 * 🔴 POURQUOI UN MODULE À PART DE `agent-tools.ts`. Les deux écrans ne parlent pas du même objet : celui-ci
 * montre les DÉFINITIONS de l'espace, l'autre le CONSENTEMENT d'un agent. Les fondre ferait un module dont
 * la moitié des gardes ne s'appliquent qu'à la moitié des routes, et c'est ainsi qu'une garde finit par
 * manquer là où elle comptait. Le découpage suit l'objet, pas la couche technique.
 *
 * ⚠️ IL NE PORTE PLUS QUE LA LECTURE (2026-09-21). Ses routes propres à l'agent de Meta (exposer, créer,
 * corriger, supprimer) servaient l'ancien onglet « Outils » du MBA, qui mélangeait cette bibliothèque et les
 * outils de l'agent de Meta. Elles vivent désormais dans `src/http/mba-outils.ts`, qui ne parle que de ceux-là
 * (spec docs/superpowers/specs/2026-09-21-outils-maison-mba-design.md, § 9). La lecture reste : l'écran des
 * outils d'un agent IA et l'assistant de construction la lisent.
 *
 * ⚠️ Son isolation passe par `scopeTenant`, pas par un numéro ni un agent dans l'URL : la bibliothèque est
 * une propriété de l'ESPACE.
 */
export interface AgentCatalogueRouteDeps {
  listCatalogue(tenantId: string): Promise<OutilBibliotheque[]>;
}

export function registerAgentCatalogue(app: FastifyInstance, deps: AgentCatalogueRouteDeps, garde: Guard): void {
  // Même forme que `registerAgentTools` : la garde est REQUISE depuis le lot 2 du plan 2026-09-14.
  const opts = { preHandler: garde };
  const base = '/tenants/:tenantId/agent-tools';

  app.get(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    return reply.code(200).send({ outils: await deps.listCatalogue(tenant) });
  });
}
