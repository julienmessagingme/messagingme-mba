import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { AgentResume } from '../agent/agent-store';
import { scopeTenant } from './scope';

export interface AgentsRouteDeps {
  listActifs(tenantId: string): Promise<AgentResume[]>;
}

/**
 * Les agents IA d'un workspace, EN LECTURE. Sert la palette du builder : sans cette liste, un bloc agent ne
 * pourrait pas être configuré, donc pas être construit.
 *
 * Réservée aux ADMINISTRATEURS, comme les formulaires et comme le builder lui-même : son seul consommateur
 * est cet écran, qu'un compte non admin ne peut pas ouvrir. L'ouvrir plus largement élargirait la surface
 * sans usage, et les codes des règles d'arrêt disent le métier du client.
 */
export function registerAgents(app: FastifyInstance, deps: AgentsRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.get('/tenants/:tenantId/agents', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ agents: await deps.listActifs(tenant) });
  });
}
