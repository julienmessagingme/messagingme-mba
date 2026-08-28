import { request } from './http';

/**
 * Les outils d'un agent IA.
 *
 * 🔴 UN OUTIL ACTIF EST EXÉCUTABLE PAR LE MODÈLE, donc par un texte qu'un contact influence. C'est pour ça
 * que l'activation est un geste explicite, qu'elle porte le nom de qui l'a faite, et que l'écran montre ce
 * que le modèle voit vraiment : les mots du client pilotent un appel de fonction, il doit pouvoir les relire
 * dans leur forme réelle.
 */

export type RisqueOutil = 'read' | 'write' | 'irreversible';

/** Ce que le client peut composer sur un paramètre. `derive_des_sorties` n'est jamais stocké : l'énumération
 *  vient des règles d'arrêt de la fiche, et de nulle part ailleurs. */
export type EditionParam = 'aucune' | 'enum' | 'derive_des_sorties';

export interface TexteBilingue { fr: string; en: string }

export interface ModeleOutil {
  handler: string;
  nomDefaut: string;
  titre: TexteBilingue;
  description: TexteBilingue;
  nePasUtiliser: TexteBilingue;
  risk: RisqueOutil;
  params: Array<{ name: string; edition: EditionParam; aideEnum?: TexteBilingue }>;
}

/** Le schéma exact envoyé au modèle. `null` quand le modèle ne voit RIEN de cet outil. */
export interface OutilExpose {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required: string[];
    additionalProperties: false;
  };
}

export type OrigineOutil = 'mba' | 'http' | 'mcp';

export interface OutilAgent {
  id: string;
  /** D'où vient le comportement : `mba` = outil maison du catalogue, `http` = connecteur du client (L2). */
  origin: OrigineOutil;
  /** La source externe, pour un connecteur. `null` pour un outil maison. */
  sourceId: string | null;
  name: string;
  title: string;
  description: string;
  nePasUtiliser: string;
  params: unknown;
  binding: Record<string, unknown>;
  risk: RisqueOutil;
  actif: boolean;
  activeLe: string | null;
  autonome: boolean;
  autonomeLe: string | null;
  expose: OutilExpose | null;
}

export interface VueOutils {
  outils: OutilAgent[];
  catalogue: ModeleOutil[];
}

const base = (tenantId: string, agentId: string) => `/tenants/${tenantId}/agents/${agentId}/tools`;

export async function listOutils(tenantId: string, agentId: string): Promise<VueOutils> {
  const r = await request<Partial<VueOutils>>(base(tenantId, agentId));
  return { outils: r.outils ?? [], catalogue: r.catalogue ?? [] };
}

/**
 * Déclare un outil de CONNECTEUR sur une source (lot L2).
 *
 * Route SÉPARÉE de l'ajout maison, exprès : l'ajout maison prend son `handler` dans le catalogue et refuse
 * tout le reste, c'est sa garde. Le risque est DÉRIVÉ de la méthode côté serveur et ne peut être que monté.
 */
export async function ajouterConnecteur(tenantId: string, agentId: string, outil: {
  sourceId: string; name: string; title: string; description: string; nePasUtiliser: string;
  methode: string; chemin: string;
  params: Array<{ name: string; type: string; source: string; description?: string; required?: boolean; contactPath?: string; value?: string | number | boolean }>;
  outputPaths: string[];
  risk?: RisqueOutil;
}): Promise<OutilAgent> {
  const r = await request<{ outil: OutilAgent }>(`${base(tenantId, agentId)}/connecteur`, {
    method: 'POST', body: JSON.stringify(outil),
  });
  return r.outil;
}

/** Ajoute un outil du catalogue. Le titre, les mots, les paramètres et le RISQUE viennent du serveur. */
export async function ajouterOutil(tenantId: string, agentId: string, handler: string, name?: string): Promise<OutilAgent> {
  const r = await request<{ outil: OutilAgent }>(base(tenantId, agentId), {
    method: 'POST',
    body: JSON.stringify(name ? { handler, name } : { handler }),
  });
  return r.outil;
}

export async function patchOutil(
  tenantId: string, agentId: string, outilId: string,
  patch: { name?: string; title?: string; description?: string; nePasUtiliser?: string; enums?: Record<string, string[]> },
): Promise<OutilAgent> {
  const r = await request<{ outil: OutilAgent }>(`${base(tenantId, agentId)}/${outilId}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
  return r.outil;
}

/** Mise en service. Le serveur y inscrit QUI a activé, d'après le jeton : rien à envoyer pour ça. */
export async function activerOutil(tenantId: string, agentId: string, outilId: string, valeur: boolean): Promise<OutilAgent> {
  const r = await request<{ outil: OutilAgent }>(`${base(tenantId, agentId)}/${outilId}/activation`, {
    method: 'PUT', body: JSON.stringify({ valeur }),
  });
  return r.outil;
}

export async function autonomieOutil(tenantId: string, agentId: string, outilId: string, valeur: boolean): Promise<OutilAgent> {
  const r = await request<{ outil: OutilAgent }>(`${base(tenantId, agentId)}/${outilId}/autonomie`, {
    method: 'PUT', body: JSON.stringify({ valeur }),
  });
  return r.outil;
}

export async function retirerOutil(tenantId: string, agentId: string, outilId: string): Promise<void> {
  await request<void>(`${base(tenantId, agentId)}/${outilId}`, { method: 'DELETE' });
}
