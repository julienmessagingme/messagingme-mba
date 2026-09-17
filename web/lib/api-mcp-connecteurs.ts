import { request } from './http';

/**
 * Les CONNECTEURS MCP : les serveurs d'outils tiers sur lesquels on branche un agent.
 *
 * 🔴 NE PAS CONFONDRE AVEC `mcp-outils.ts`, QUI VA DANS L'AUTRE SENS. Celui-là décrit NOTRE serveur MCP,
 * celui que les clients branchent sur Claude ou ChatGPT pour lire leurs conversations. Ici, c'est nous qui
 * allons chercher des outils chez quelqu'un d'autre. Deux sens, deux fichiers, et c'est aussi pour ça que
 * les deux entrées de menu ne partagent aucun mot à part MCP.
 *
 * 🔴 LE SECRET NE REVIENT JAMAIS, comme pour un connecteur API. L'écran connaît l'EXISTENCE de
 * l'authentification, jamais sa valeur.
 */

export type AuthMcp = 'none' | 'bearer' | 'header';

export interface ServeurMcp {
  id: string;
  label: string;
  baseUrl: string;
  authKind: AuthMcp;
  authHeaderName: string | null;
  status: string;
  /** Dernière fois que ce serveur a répondu. C'est ce qui rend un jeton mort visible AVANT un contact. */
  lastOkAt: string | null;
  lastError: string | null;
}

/** D'où vient la valeur d'un paramètre. Liste FERMÉE, alignée sur `src/agent/llm/tool-schema.ts`. */
export type SourceParamMcp = 'modele' | 'contact' | 'champ' | 'fixe';

export interface ParamMcp {
  name: string;
  type: string;
  source: SourceParamMcp;
  required?: boolean;
  description?: string;
  cle?: string;
  contactPath?: string;
  value?: string | number | boolean;
  /** Le chemin dans le schéma DISTANT. Affiché au client, jamais exposé au modèle. */
  cheminMcp?: string;
}

export interface OutilMcp {
  id: string;
  name: string;
  nomDistant: string;
  title: string;
  description: string;
  nePasUtiliser: string;
  params: ParamMcp[];
  risk: 'read' | 'write' | 'irreversible';
  annonce: unknown;
  /** `null` = activable. Sinon la raison, telle que le serveur nous l'a value : on l'affiche en clair. */
  nonActivable: string | null;
  indisponibleLe: string | null;
  consommateursActifs: number;
}

export type ChangementMcp =
  | { type: 'nouveau'; nom: string }
  | { type: 'inchange'; nom: string }
  | { type: 'schema_change'; nom: string; consentementsTombes: number }
  | { type: 'disparu'; nom: string; consentementsTombes: number };

const base = (tenantId: string) => `/agents/${tenantId}/mcp`;

export function listerServeursMcp(tenantId: string): Promise<{ serveurs: ServeurMcp[] }> {
  return request<{ serveurs: ServeurMcp[] }>(base(tenantId));
}

export function listerOutilsMcp(tenantId: string, sourceId: string): Promise<{ outils: OutilMcp[] }> {
  return request<{ outils: OutilMcp[] }>(`${base(tenantId)}/${sourceId}/outils`);
}

/** Éprouve le serveur : `initialize` seul, rien n'est importé. */
export function eprouverServeurMcp(tenantId: string, sourceId: string): Promise<{ ok: boolean; erreur?: string }> {
  return request<{ ok: boolean; erreur?: string }>(`${base(tenantId)}/${sourceId}/eprouver`, { method: 'POST' });
}

/**
 * Le plan, SANS rien écrire.
 *
 * 🔴 C'est la moitié qui rend le rafraîchissement acceptable : écraser n'est acceptable que si l'on montre
 * QUOI avant de le faire, suppressions et consentements qui tombent compris.
 */
export function apercuMcp(tenantId: string, sourceId: string): Promise<{ plan: ChangementMcp[]; tronque: boolean }> {
  return request<{ plan: ChangementMcp[]; tronque: boolean }>(`${base(tenantId)}/${sourceId}/apercu`);
}

export function importerMcp(tenantId: string, sourceId: string): Promise<{ plan: ChangementMcp[]; tronque: boolean }> {
  return request<{ plan: ChangementMcp[]; tronque: boolean }>(`${base(tenantId)}/${sourceId}/importer`, { method: 'POST' });
}

export function reglerOutilMcp(tenantId: string, outilId: string, patch: {
  params?: Array<{ name: string; source: SourceParamMcp; cle?: string; contactPath?: string; value?: string | number | boolean }>;
  risk?: OutilMcp['risk'];
  nePasUtiliser?: string;
}): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`${base(tenantId)}/outils/${outilId}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
}
