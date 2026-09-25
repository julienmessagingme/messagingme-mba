import type { AgentBrain, DecisionAgent } from '../src/agent/brain';

/**
 * Cerveau bouchonné : il rend une décision fixe, sans réseau ni modèle.
 *
 * Il sert à durcir le chemin chaud (gardes, plafonds, sorties, envoi) INDÉPENDAMMENT du modèle, et il est
 * le double des tests du tour. ⚠️ Il n'a rien à faire dans un chemin de production : un agent déployé
 * répondrait la même phrase à tout le monde.
 */
export class FakeAgentBrain implements AgentBrain {
  /** Les appels reçus, pour qu'un test puisse prouver que le cerveau N'A PAS été appelé. */
  public readonly appels: Array<{ agentId: string; tenantId: string; transcript: unknown[]; deadline: number }> = [];

  constructor(private readonly decision: DecisionAgent = { texte: 'Bonjour, je peux vous aider.', sortie: null }) {}

  async penser(input: { agentId: string; tenantId: string; transcript: unknown[]; deadline: number }): Promise<DecisionAgent> {
    this.appels.push(input);
    return this.decision;
  }
}
