import { request } from './http';

/** Une règle d'arrêt déclarée sur la fiche d'un agent. Son `code` devient le handle `sortie:<code>` du bloc. */
export interface SortieAgent {
  code: string;
  label: string;
}

export type StatutAgent = 'draft' | 'active' | 'disabled';

/** Un agent, tel que la palette du builder et la liste de l'écran de réglage le voient. */
export interface AgentResume {
  id: string;
  label: string;
  status: StatutAgent;
  sorties: SortieAgent[];
}

/** La partie de la fiche que le client décrit, et que l'IA de construction remplira un jour. */
export interface FicheContenu {
  nom: string;
  objectif: string;
  ton: string;
  personnalite: string;
  reglesTransfert: string;
  sorties: SortieAgent[];
}

/** La fiche ENTIÈRE, telle que l'écran de réglage l'édite. */
export interface AgentComplet {
  id: string;
  label: string;
  status: StatutAgent;
  mentionIa: string;
  modele: string;
  maxTours: number;
  maxAppelsOutils: number;
  budgetMicroEur: number;
  inactiviteMinutes: number;
  contactInconnu: 'aucun_outil' | 'lecture_seule' | 'tous';
  contenu: FicheContenu;
  /** Compteur d'écritures de la fiche, renvoyé tel quel dans un patch de fiche : c'est le verrou qui empêche
   *  deux surfaces d'écraser la même clé en silence. */
  ficheVersion: number;
}

/** Un patch : tout est optionnel, et `contenu` est une FUSION (seules les clés présentes sont écrites).
 *  `ficheVersionAttendue` accompagne un patch de fiche et le fait refuser en 409 si elle a bougé. */
export type PatchAgent = Partial<Omit<AgentComplet, 'id' | 'contenu' | 'ficheVersion'>> & {
  contenu?: Partial<FicheContenu>;
  ficheVersionAttendue?: number;
};

/**
 * Les agents du workspace. Par défaut les ACTIFS seulement, ce dont la palette du builder a besoin : un
 * brouillon proposé dans un scénario promettrait une conversation qui n'aurait pas lieu.
 */
export async function listAgents(tenantId: string, opts: { tous?: boolean } = {}): Promise<AgentResume[]> {
  const q = opts.tous ? '?statut=tous' : '';
  const r = await request<{ agents?: AgentResume[] }>(`/tenants/${tenantId}/agents${q}`);
  return r.agents ?? [];
}

/**
 * Le solde prépayé du workspace, en micro-euros. `null` = aucun solde configuré sur cette instance.
 *
 * 🔴 LECTURE SEULE, et c'est le sujet. Le rechargement vit sur la surface d'exploitation, sous une autorité
 * séparée du compte client : un client qui pourrait se créditer lui-même n'aurait plus de prépayé du tout.
 */
export async function getSoldeAgent(tenantId: string): Promise<number | null> {
  const r = await request<{ soldeMicroEur: number | null }>(`/tenants/${tenantId}/agents/solde`);
  return r.soldeMicroEur;
}

export async function getAgent(tenantId: string, agentId: string): Promise<AgentComplet> {
  return (await request<{ agent: AgentComplet }>(`/tenants/${tenantId}/agents/${agentId}`)).agent;
}

export async function createAgent(tenantId: string, label: string): Promise<AgentComplet> {
  const r = await request<{ agent: AgentComplet }>(`/tenants/${tenantId}/agents`, {
    method: 'POST',
    body: JSON.stringify({ label }),
  });
  return r.agent;
}

export async function deleteAgent(tenantId: string, agentId: string): Promise<void> {
  await request<void>(`/tenants/${tenantId}/agents/${agentId}`, { method: 'DELETE' });
}

export async function patchAgent(tenantId: string, agentId: string, patch: PatchAgent): Promise<AgentComplet> {
  const r = await request<{ agent: AgentComplet }>(`/tenants/${tenantId}/agents/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return r.agent;
}

/**
 * Ce que l'agent a CONSOMMÉ, sur une fenêtre décidée par le serveur.
 *
 * 🔴 UNE MESURE, PAS UN PLAFOND. Le plafond par conversation existe toujours et protège toujours d'une
 * boucle qui s'emballe ; il n'a rien à faire dans l'écran où l'on vient voir ce que l'agent a coûté.
 *
 * `null` = la console n'a pas de store de sessions : on n'affiche alors RIEN, plutôt qu'un zéro qui se
 * lirait « cet agent n'a rien consommé ».
 */
export interface ConsommationAgent {
  sessions: number;
  tokensEntree: number;
  tokensSortie: number;
  coutMicroEur: number;
  jours: number;
}

export async function consommationAgent(tenantId: string, agentId: string): Promise<ConsommationAgent | null> {
  const r = await request<{ consommation: ConsommationAgent | null }>(
    `/tenants/${tenantId}/agents/${agentId}/consommation`,
  );
  return r.consommation ?? null;
}
