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
  /** La REQUÊTE que cet outil déclenche (migration 0105), ou null pour un outil maison. C'est elle qui porte
   *  la méthode, le chemin, le corps et les variables : l'outil ne les redécrit plus. */
  requestId?: string | null;
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
 * Branche une REQUÊTE de la bibliothèque sur cet agent (migration 0105).
 *
 * 🔴 L'APPEL N'EST PLUS DÉCRIT ICI. On ne saisit que les MOTS : le nom exposé au modèle, à quoi ça sert, et
 * quand ne pas l'appeler. La méthode, le chemin, le corps et les variables viennent de la requête, déjà
 * éprouvée avec son bouton Test. Le risque est DÉRIVÉ de sa méthode côté serveur et ne peut être que monté.
 *
 * Rend AUSSI `envoi` : ce qui partira, en français, pour le faire confirmer au client. C'est le seul moment
 * où il peut s'apercevoir qu'un connecteur enverra le dernier message de ses contacts à un système tiers.
 */
export async function ajouterConnecteur(tenantId: string, agentId: string, outil: {
  requeteId: string; name: string; title: string; description: string; nePasUtiliser: string;
  risk?: RisqueOutil;
}): Promise<{ outil: OutilAgent; envoi: Array<{ nom: string; libelle: string }> }> {
  return request(`${base(tenantId, agentId)}/connecteur`, { method: 'POST', body: JSON.stringify(outil) });
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
