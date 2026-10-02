import { request } from './http';

/**
 * L'ONGLET « OUTILS » DE L'AGENT DE META, côté client (spec 2026-09-21-outils-maison-mba, § 9).
 * Miroir de `src/mba/vue-outils.ts` et `src/http/mba-outils.ts`.
 */
export type TypeOutilMba = 'tag' | 'champ' | 'bloc' | 'scenario' | 'connecteur';

export type CibleVue =
  | { type: 'tag'; tag: string }
  | { type: 'champ'; champ: string; valeurs: string[] }
  | { type: 'bloc'; workflowId: string; code: string; scenario: string | null; bloc: string | null }
  | { type: 'scenario'; workflowId: string; scenario: string | null }
  | { type: 'connecteur'; requeteId: string; libelle: string | null }
  | { type: 'mcp'; sourceId: string | null; serveur: string | null }
  | { type: 'inconnu' };

export interface OutilMbaVue {
  id: string;
  name: string;
  title: string;
  description: string;
  nePasUtiliser: string;
  /** `mcp` ne se crée pas dans cet onglet : il vient de la bibliothèque, ses réglages vivent dans Connecteurs MCP. */
  type: TypeOutilMba | 'mcp' | 'inconnu';
  cible: CibleVue;
  /** Pourquoi la cible n'existe plus, ou `null`. Texte du serveur, affiché tel quel. */
  cibleManquante: string | null;
  /** Les agents IA qui partagent cet outil (connecteur et MCP). */
  aussiUtilisePar: string[];
  /**
   * Faux quand le départ de son auteur l'a éteint : l'agent de Meta ne peut plus s'en servir (le relais refuse).
   * ⚠️ Il reste LISTÉ chez Meta jusqu'au prochain envoi : rien ne republie au départ d'un collaborateur.
   */
  actif: boolean;
  /** Part-il chez Meta quand il est actif ? Faux pour un appel supprimé ou un outil illisible. */
  publiable: boolean;
  /** Ce que l'outil peut faire. `irreversible` se DIT à l'écran : l'agent de Meta appelle sans validation humaine. */
  risque: 'read' | 'write' | 'irreversible';
}

export type CibleSaisie =
  | { type: 'tag'; tag: string }
  | { type: 'champ'; champ: string; valeurs: string[] }
  | { type: 'bloc'; workflowId: string; code: string }
  | { type: 'scenario'; workflowId: string }
  | { type: 'connecteur'; requeteId: string };

/** Un bloc d'un scénario publié, envoyable seul ou non (miroir de `BlocPropose`, `src/mba/outils-maison.ts`). */
export interface BlocPropose {
  workflowId: string;
  scenario: string;
  code: string;
  nom: string;
  type: string;
  envoyable: boolean;
  /** Pourquoi il ne peut pas partir seul, ou `null`. Texte du serveur, affiché tel quel. */
  raison: string | null;
}

export interface TextesOutil { name: string; title: string; description: string; nePasUtiliser: string }

/** Un outil MCP de la bibliothèque que l'agent de Meta peut recevoir (miroir de `src/mba/vue-outils.ts`). */
export interface OutilMcpProposable {
  id: string;
  name: string;
  title: string;
  description: string;
  serveur: string | null;
  risque: 'read' | 'write' | 'irreversible';
  aussiUtilisePar: string[];
}

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
