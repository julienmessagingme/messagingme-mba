import { request } from './http';
import type { BlocPropose, CibleSaisie, OutilMbaVue, OutilMcpProposable, TextesOutil } from './partage/outils-mba';

const base = (tenantId: string): string => `/tenants/${tenantId}/mba-outils`;

export function listerOutilsMba(tenantId: string): Promise<{ outils: OutilMbaVue[]; phoneNumberId: string | null }> {
  return request(base(tenantId));
}

export function creerOutilMba(tenantId: string, corps: TextesOutil & { cible: CibleSaisie }): Promise<{ id: string }> {
  return request(base(tenantId), { method: 'POST', body: JSON.stringify(corps) });
}

export function modifierOutilMba(
  tenantId: string, id: string, patch: Partial<TextesOutil> & { cible?: CibleSaisie },
): Promise<{ id: string }> {
  return request(`${base(tenantId)}/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function retirerOutilMba(tenantId: string, id: string): Promise<void> {
  await request<void>(`${base(tenantId)}/${id}`, { method: 'DELETE' });
}

/** Les blocs d'UN scénario : l'écran choisit d'abord le scénario, puis le bloc. */
export function listerBlocsMba(tenantId: string, workflowId: string): Promise<{ blocs: BlocPropose[] }> {
  return request(`${base(tenantId)}/blocs?workflowId=${encodeURIComponent(workflowId)}`);
}

/** Les outils MCP de la bibliothèque, appelables et pas encore donnés à l'agent de Meta (2026-10-02). */
export function listerMcpProposablesMba(tenantId: string): Promise<{ outils: OutilMcpProposable[] }> {
  return request(`${base(tenantId)}/mcp`);
}

/** Donner un outil MCP de la bibliothèque à l'agent de Meta : le serveur le rattache et l'active. */
export function proposerMcpMba(tenantId: string, id: string): Promise<{ id: string }> {
  return request(`${base(tenantId)}/mcp/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({}) });
}

/** Rallumer un outil éteint par le départ de son auteur (plan 2026-09-21-outils-maison-mba, écart 4). */
export function reactiverOutilMba(tenantId: string, id: string): Promise<{ actif: true }> {
  return request(`${base(tenantId)}/${id}/actif`, { method: 'PUT', body: JSON.stringify({ valeur: true }) });
}
