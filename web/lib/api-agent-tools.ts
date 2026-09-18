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

/** Un geste du moment. Miroir du schéma serveur, recopié comme le reste de ce fichier plutôt que d'importer
 *  du code serveur dans le bundle client. */
export type GesteMoment =
  | { type: 'tag'; valeur: string }
  | { type: 'variable'; champ: string; valeur: string };

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
  /**
   * LES GESTES DU MOMENT (migration 0158) : ce que NOUS faisons quand il se produit, sans le demander au
   * modèle. Miroir du contrat serveur (`src/agent/gestes.ts`).
   *
   * ⚠️ Ils sont INDÉPENDANTS de la réussite de la réponse principale : ils marquent que la SITUATION s'est
   * produite. D'où les libellés par défaut, qui disent « demandé » et jamais « pris ».
   */
  gestes: GesteMoment[];
  params: unknown;
  binding: Record<string, unknown>;
  risk: RisqueOutil;
  actif: boolean;
  activeLe: string | null;
  autonome: boolean;
  autonomeLe: string | null;
  expose: OutilExpose | null;
  /**
   * 🔴 L'ÉTAT MCP, SUR L'ÉCRAN OÙ LE CLIENT REDONNE SON AUTORISATION. Le serveur les envoyait déjà
   * (`{ ...outil, expose }` sur un `OutilComplet`), ce type ne les déclarait pas. Or c'est précisément
   * l'écran que le récit anti-IDOR nomme (« le client le redonne depuis AI Agent > Outils, qui n'est PAS
   * l'écran de clouage ») : un outil mort y ressemblait encore à un outil vivant, et le client
   * l'apprenait en recevant un refus.
   */
  mcpNonActivable?: string | null;
  mcpIndisponibleLe?: string | null;
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
/** Ce qu'un agent fait de la réponse d'un connecteur. MÊMES valeurs que `src/agent/catalog.ts`. */
export type NatureOutil = 'pousse' | 'integre';

export async function ajouterConnecteur(tenantId: string, agentId: string, outil: {
  requeteId: string; name: string; title: string; description: string; nePasUtiliser: string;
  /**
   * Ce que CET agent fait de la réponse, et les champs qu'il lit (migration 0150).
   *
   * 🔴 OBLIGATOIRES, comme côté serveur. Les rendre optionnels ici ferait retomber l'écran sur une
   * dérivation silencieuse, c'est-à-dire sur la question qu'on a précisément décidé de POSER.
   */
  nature: NatureOutil; outputPaths: string[];
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
  patch: { name?: string; title?: string; description?: string; nePasUtiliser?: string; enums?: Record<string, string[]>; gestes?: GesteMoment[] },
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

/**
 * Retire l'outil de CET agent. La DÉFINITION reste dans l'espace (migration 0127).
 *
 * 🔴 CETTE ROUTE SUPPRIMAIT POUR TOUT LE MONDE JUSQU'AU 2026-09-10. Depuis que la définition appartient à
 * l'espace, la supprimer depuis l'écran d'un seul agent rendrait muets les autres agents qui s'en servent :
 * elle DÉTACHE. La suppression définitive vit dans l'écran « Outils de l'espace », qui refuse tant qu'un
 * agent y est rattaché.
 */
export async function retirerOutil(tenantId: string, agentId: string, outilId: string): Promise<void> {
  await request<void>(`${base(tenantId, agentId)}/${outilId}`, { method: 'DELETE' });
}

/** Une DÉFINITION de l'espace, vue de la bibliothèque : ce qu'elle est, et QUI s'en sert. */
export interface OutilBibliotheque {
  id: string;
  name: string;
  title: string;
  description: string;
  origin: OrigineOutil;
  risk: 'read' | 'write' | 'irreversible';
  sourceId: string | null;
  /** `null` = activable. Sinon la raison, écrite par le serveur MCP et affichée telle quelle. */
  mcpNonActivable: string | null;
  /** L'outil a disparu du catalogue distant. La ligne reste, elle est la trace de ce qui a tourné. */
  mcpIndisponibleLe: string | null;
  consommateurs: Array<{ cle: string; actif: boolean; agentId: string | null; agentLabel: string | null }>;
}

/**
 * La bibliothèque d'outils de l'ESPACE (migration 0127).
 *
 * ⚠️ Indexée par TENANT, pas par agent : c'est ce que le lot 1 vient d'établir, une définition appartient à
 * l'espace et plusieurs agents s'en servent.
 */
export function getBibliothequeOutils(tenantId: string): Promise<{ outils: OutilBibliotheque[] }> {
  return request<{ outils: OutilBibliotheque[] }>(`/tenants/${tenantId}/agent-tools`);
}

/**
 * Branche ou débranche un outil de la bibliothèque sur cet agent.
 *
 * 🔴 RATTACHER N'EST PAS ACTIVER, et les deux routes sont séparées exprès : rattacher rend l'outil
 * DISPONIBLE, activer l'expose au modèle. Un seul geste qui ferait les deux exposerait au modèle un outil
 * dont personne n'a relu les mots, ce que la migration 0086 existe pour empêcher.
 */
export function rattacherOutil(tenantId: string, agentId: string, outilId: string, valeur: boolean): Promise<{ rattache: boolean }> {
  // ⚠️ `base(...)`, PAS un chemin recopié : la route s'appelle `/tools` et non `/outils`, et la recopier de
  // mémoire a produit un 404 que seule une sonde sur la PRODUCTION a montré. Le branchement aurait échoué à
  // chaque fois, avec un message parlant d'un outil « qui n'a pas pu être enregistré ».
  return request<{ rattache: boolean }>(`${base(tenantId, agentId)}/${outilId}/rattachement`, {
    method: 'PUT', body: JSON.stringify({ valeur }),
  });
}

/** Supprime la DÉFINITION, donc pour tout le monde. Le serveur REFUSE en 409 tant qu'elle est rattachée. */
/**
 * Crée un outil de connecteur rattaché DIRECTEMENT à l'agent de Meta, sans passer par un agent IA.
 *
 * 🔴 IL N'Y AVAIT AUCUN CHEMIN POUR ÇA. Un outil naissait en le donnant à un agent IA : exposer un appel à
 * Meta obligeait à créer un agent dont on n'a pas besoin, et à répondre pour lui à des questions que Meta
 * ignore (il appelle le système du client en direct et lit toute la réponse).
 *
 * ⚠️ AUCUNE NATURE NI AUCUN CHAMP ICI, délibérément : ils n'auraient aucun effet de ce côté.
 */
export async function creerOutilPourMba(tenantId: string, outil: {
  requeteId: string; name: string; title: string; description: string; nePasUtiliser: string;
}): Promise<{ id: string; expose: boolean }> {
  return request(`/tenants/${tenantId}/agent-tools/connecteur-mba`, { method: 'POST', body: JSON.stringify(outil) });
}

export async function supprimerDefinitionOutil(tenantId: string, outilId: string): Promise<void> {
  await request<void>(`/tenants/${tenantId}/agent-tools/${outilId}`, { method: 'DELETE' });
}

/**
 * Expose, ou retire, cet outil au Meta Business Agent.
 *
 * ⚠️ N'ENVOIE PAS LE NUMÉRO : le serveur le résout. Le faire porter au navigateur est exactement ce qui a
 * cassé le toggle MBA trois fois le 2026-09-10.
 */
export async function exposerOutilAuMba(tenantId: string, outilId: string, valeur: boolean): Promise<{ expose: boolean }> {
  return request<{ expose: boolean }>(`/tenants/${tenantId}/agent-tools/${outilId}/mba`, {
    method: 'PUT', body: JSON.stringify({ valeur }),
  });
}

/** Un geste du plan de publication, tel que le serveur le rend. */
export interface GestePublication {
  type: 'connecteur_creer' | 'connecteur_modifier' | 'connecteur_supprimer' | 'secret_poser'
  | 'outil_creer' | 'outil_modifier' | 'outil_supprimer';
  nom: string;
}

/** L'APERÇU : ce qui changera chez Meta si l'on publie. N'écrit RIEN. */
export function apercuPublicationMba(tenantId: string): Promise<{ gestes: GestePublication[]; phoneNumberId: string | null }> {
  return request<{ gestes: GestePublication[]; phoneNumberId: string | null }>(`/tenants/${tenantId}/mba-publication`);
}

/** Exécute le plan. Le serveur le RECALCULE : on ne lui renvoie pas celui qu'on a affiché. */
export function publierChezMeta(tenantId: string): Promise<{ faits: GestePublication[] }> {
  return request<{ faits: GestePublication[] }>(`/tenants/${tenantId}/mba-publication`, { method: 'POST' });
}
