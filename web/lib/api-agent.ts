import { request } from './http';

/** Une règle d'arrêt déclarée sur la fiche d'un agent. Son `code` devient le handle `sortie:<code>` du bloc. */
export interface SortieAgent {
  code: string;
  label: string;
}

/** Un agent ACTIF, tel que la palette du builder le propose. */
export interface AgentResume {
  id: string;
  label: string;
  sorties: SortieAgent[];
}

/** Les agents actifs du workspace. Un workspace sans agent actif grise la brique « Agent IA ». */
export async function listAgents(tenantId: string): Promise<AgentResume[]> {
  const r = await request<{ agents?: AgentResume[] }>(`/tenants/${tenantId}/agents`);
  return r.agents ?? [];
}
