import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { essayerAgent, type DepsEssai } from '../agent/essai';
import { ESSAIS_AFFICHES } from '../agent/test-runs';
import { corpsDuRefus } from '../lib/issue';
import { espaceVerifie, estUuid } from './scope';

/**
 * Le bac à sable : parler à son agent depuis la console, avant de l'activer. L'essai passe par `essayerAgent`
 * (`src/agent/essai.ts`), que l'outil MCP `test_agent` appelle aussi : solde, débit au prix client et archivage y
 * vivent, la route ne fait que traduire l'issue en statut. Une panne qui n'est pas celle du fournisseur lève, et
 * remonte en 500 opaque.
 */

/** Les dépendances de la route : celles de l'essai, les MÊMES objets que le MCP reçoit. */
export type AgentTestRouteDeps = DepsEssai;

export function registerAgentTest(app: FastifyInstance, deps: AgentTestRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  /** Les derniers essais de cet agent, du plus récent au plus ancien : 200 avec une liste vide, jamais 404. */
  app.get('/tenants/:tenantId/agents/:agentId/tests', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) return reply.code(404).send({ error: 'agent introuvable' });
    return reply.code(200).send({ essais: await deps.essais.lister(tenant, agentId, ESSAIS_AFFICHES) });
  });

  app.post('/tenants/:tenantId/agents/:agentId/test', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { agentId } = req.params as { agentId: string };
    const r = await essayerAgent(deps, tenant, agentId, req.body, 'formulaire');
    if (!r.ok) return reply.code(r.statut).send(corpsDuRefus(r));
    return reply.code(200).send(r.valeur);
  });
}
