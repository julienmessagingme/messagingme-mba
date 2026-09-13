'use client';

/**
 * Les scenarios et leurs contenus : formulaires, graphes de blocs, tags, champs.
 *
 * Sorti de `lib/api.ts` le 2026-09-01 (lot 5 du programme II), qui pesait 1 874 lignes. Le socle HTTP
 * (`./http`) etait deja extrait : ce decoupage-ci ne separe que des surfaces d'appel, sans etat partage.
 * `lib/api.ts` reste le point d'entree et reexporte tout, donc AUCUN des 67 importeurs ne change.
 */

import { request } from '../http';

// --- Flows (constructeur de formulaire RICHE : texte / image / champ) ---

export type FlowFieldType =
  | 'text' | 'email' | 'phone' | 'number' | 'passcode'
  | 'textarea' | 'date'
  | 'dropdown' | 'radio' | 'checkbox' | 'optin';
export type FlowTextKind = 'heading' | 'subheading' | 'body' | 'caption';
/** Types de champ qui exigent une liste d'options (dropdown/radio/checkbox). */
export const FLOW_CHOICE_TYPES: FlowFieldType[] = ['dropdown', 'radio', 'checkbox'];

/** Condition de visibilité ENVOYÉE : `field` = LIBELLÉ du champ source (le serveur résout libellé -> clé).
 *  Source admissible : champ dropdown/radio/optin situé AVANT l'élément sur le MÊME écran. */
export interface FlowVisibleIfInput {
  field: string;
  op: 'eq' | 'neq';
  value: string | boolean;
}
/** Condition de visibilité STOCKÉE : `fieldKey` = clé dérivée du champ source (pour re-seeder l'édition). */
export interface FlowVisibleIf {
  fieldKey: string;
  op: 'eq' | 'neq';
  value: string | boolean;
}
/** Élément riche envoyé à la création d'un flow, dans l'ordre. `saveTo` (sur un champ) : clé du user field
 *  cible ; absent -> le serveur crée un user field d'après le libellé (mapping par défaut). `options` :
 *  requis pour les champs de choix (dropdown/radio/checkbox). `visibleIf` : affichage conditionnel. */
export type FlowElementInput =
  | { kind: FlowTextKind; text: string; visibleIf?: FlowVisibleIfInput }
  | { kind: 'image'; src: string; visibleIf?: FlowVisibleIfInput }
  | { kind: 'field'; label: string; type: FlowFieldType; required: boolean; saveTo?: string; options?: string[]; visibleIf?: FlowVisibleIfInput };

export interface FlowField {
  label: string;
  type: FlowFieldType;
  required: boolean;
  key: string;
}
/** Élément riche STOCKÉ (les champs portent leur clé dérivée) — sert à pré-remplir l'édition. */
export type FlowElement =
  | { kind: FlowTextKind; text: string; visibleIf?: FlowVisibleIf }
  | { kind: 'image'; src: string; visibleIf?: FlowVisibleIf }
  | { kind: 'field'; label: string; type: FlowFieldType; required: boolean; key: string; options?: string[]; visibleIf?: FlowVisibleIf };
/** Écran STOCKÉ (le serveur normalise : un flow mono-écran historique arrive comme [{ elements }]).
 *  `cta` = bouton « Continuer » d'un écran intermédiaire ; le DERNIER écran porte le cta global du flow. */
export interface FlowScreen {
  title?: string;
  cta?: string;
  elements: FlowElement[];
}
/** Écran ENVOYÉ à la création/édition (1 à 10 écrans, chaque écran >= 1 élément). */
export interface FlowScreenInput {
  title?: string;
  cta?: string;
  elements: FlowElementInput[];
}
export interface FlowSummary {
  id: string;
  name: string;
  status: 'DRAFT' | 'PUBLISHED';
  /** Champs dérivés (kind='field') — pour l'aperçu de la liste. */
  fields: FlowField[];
  /** Écrans riches (null pour les flows antérieurs au modèle) : aperçu détaillé + pré-remplissage de l'édition. */
  screens?: FlowScreen[] | null;
  /** Mapping clé champ -> clé user field, pour restaurer le « enregistrer dans » à l'édition. */
  mapping?: Record<string, string> | null;
  /** Libellé du bouton final (Footer du dernier écran) : null/absent = défaut « Envoyer ». */
  cta?: string | null;
  createdAt: string;
}
export function listFlows(tenantId: string): Promise<{ flows: FlowSummary[] }> {
  return request<{ flows: FlowSummary[] }>(`/tenants/${tenantId}/flows`);
}
export function createFlow(tenantId: string, input: { name: string; screens: FlowScreenInput[]; cta?: string }): Promise<{ id: string; status: string; name: string; fields: FlowField[] }> {
  return request(`/tenants/${tenantId}/flows`, { method: 'POST', body: JSON.stringify(input) });
}
/** Édite un flow DRAFT (réécrit le flow_json). 409 si le flow est PUBLISHED (immuable). */
export function updateFlow(tenantId: string, flowId: string, input: { name: string; screens: FlowScreenInput[]; cta?: string }): Promise<{ id: string; status: string; name: string; fields: FlowField[] }> {
  return request(`/tenants/${tenantId}/flows/${flowId}`, { method: 'PATCH', body: JSON.stringify(input) });
}
/** « Dupliquer pour modifier » : clone un flow (publié ou draft) en un nouveau DRAFT éditable. */
export function duplicateFlow(tenantId: string, flowId: string): Promise<{ id: string; status: string; name: string; fields: FlowField[] }> {
  return request(`/tenants/${tenantId}/flows/${flowId}/duplicate`, { method: 'POST' });
}
export function publishFlow(tenantId: string, flowId: string): Promise<{ id: string; status: string }> {
  return request(`/tenants/${tenantId}/flows/${flowId}/publish`, { method: 'POST' });
}
/** Supprime un formulaire : un DRAFT est supprimé, un PUBLISHED est déprécié côté Meta (immuable). */
export function deleteFlow(tenantId: string, flowId: string): Promise<{ id: string; deleted: boolean }> {
  return request(`/tenants/${tenantId}/flows/${flowId}`, { method: 'DELETE' });
}
/** Compte-rendu de la réconciliation avec le compte WhatsApp Manager (voir POST /flows/refresh). */
export interface FlowRefreshReport {
  /** Formulaires vus chez Meta et créés chez nous (structure inconnue : Meta ne la renvoie pas). */
  importes: number;
  /** Formulaires déjà connus dont le nom ou le passage à « publié » a été aligné sur Meta. */
  majs: number;
  /** Formulaires laissés de côté : statut hors de notre modèle (déprécié, bloqué), ou id d'un autre espace. */
  ignores: number;
  /** Formulaires que nous connaissons et que Meta ne liste plus. Comptés, jamais supprimés d'office. */
  absents: number;
}
/** « Rafraîchir » : va chercher les formulaires du compte WhatsApp Manager et met la liste locale à jour. */
export function refreshFlows(tenantId: string): Promise<FlowRefreshReport> {
  return request(`/tenants/${tenantId}/flows/refresh`, { method: 'POST' });
}

// --- Workflows (bot builder : graphe de blocs) ---

// `rcs_message` : envoi sur le canal RCS, DEUX sorties ('sent' / 'unreachable') -> permet de brancher un
// repli WhatsApp sur les contacts que le RCS n'atteint pas.
// `email` : envoi via une boîte SMTP connectée (node « Envoi de mail »). Action SYNCHRONE best-effort (un
// échec est journalisé côté serveur, jamais bloquant) -> une seule sortie, comme tag/field/action.
// `question` : pose une question au contact, avec un MENU de reponses (liste interactive WhatsApp) ou
// sans menu. Il attend TOUJOURS une reponse, et il est le seul bloc a porter en plus une echeance.
// Sorties : `row:<i>` par ligne du menu, `timeout` a l'echeance, et l'arete libre pour une reponse ecrite.
// `http` : joue un appel DEJA mis au point dans Tools > Connecteurs API et range sa reponse dans un champ du
// contact. Action synchrone non bloquante, comme `tag` ou `action`.
// ⚠️ CETTE LISTE EST UN MIROIR de `WORKFLOW_NODE_TYPES` (`src/workflow/graph.ts`), qui FAIT AUTORITE : un
// type present d'un seul cote produit soit un bloc que le serveur refuse d'enregistrer, soit un bloc que
// l'ecran ne sait pas rendre. `tests/web-node-types-parity.test.ts` casse des que les deux divergent.
/** Résultat d'un essai de « Fonction JS » : ce que le bac à sable a produit, ou la faute du client. */
export interface EssaiJs { ok: boolean; valeur: string; erreur?: string }

export type WorkflowNodeType = 'template' | 'quick_message' | 'inbox' | 'flow' | 'question' | 'tag' | 'field' | 'condition' | 'action' | 'wait' | 'mba_handoff' | 'mba_disable' | 'rcs_message' | 'email' | 'agent' | 'http' | 'js';
export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}
export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
}
export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}
export interface WorkflowSummary {
  id: string;
  name: string;
  /** Code public « scn_<client>_<ulid> » (schéma A). Absent tant que le backfill n'a pas tourné. */
  code?: string | null;
  /**
   * Le graphe EN LIGNE : celui que les contacts parcourent. Ne change que sur « Publier ».
   *
   * ⚠️ ABSENT de la LISTE depuis le 2026-09-01, et c'est voulu : elle renvoyait deux graphes complets par
   * ligne pour des écrans qui n'affichent qu'un nom. Il n'est présent que sur `getWorkflow(id)`, que
   * l'écran d'édition appelle déjà à l'ouverture. Ce que les écrans en tiraient est devenu `nodeCount`,
   * `hasDraft` et `campaignEligible`.
   */
  graph?: WorkflowGraph;
  /** Le brouillon en attente. null = aucun, ce qui est en ligne est aussi ce qui est édité. Absent de la
   *  liste, comme `graph` : c'est `hasDraft` qui le remplace. */
  draftGraph?: WorkflowGraph | null;
  /** Nombre de blocs. Rendu par la LISTE (calculé en base), absent du détail. */
  nodeCount?: number;
  /** Un brouillon attend-il d'être publié ? Rendu par la LISTE, absent du détail (`draftGraph` y répond). */
  hasDraft?: boolean;
  /**
   * Le scénario peut-il ouvrir une CAMPAGNE ? Rendu par la LISTE, calculé côté serveur avec la MÊME règle
   * que la garde de création : l'écran ne peut donc pas proposer un scénario que la création refuserait.
   */
  campaignEligible?: boolean;
  /**
   * PAR QUOI il ouvre, quand il le peut. Rendu par la LISTE, à côté de `campaignEligible` et jamais à sa
   * place : les trois écrans qui lisent le booléen continuent de le lire.
   *
   * ⚠️ ABSENT = un serveur plus ancien. `web/lib/campagne-scenario.ts` GARDE alors le scénario au lieu de
   * le masquer : le front part sur Vercel à chaque push, l'API suit à la main, et masquer ce qu'on ne sait
   * pas viderait toute la liste entre les deux.
   */
  canalOuverture?: 'whatsapp' | 'rcs' | null;
  /** Dernière mise en ligne. null = jamais publié (scénario neuf, ou antérieur au bouton). */
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}
/** Ce que l'éditeur OUVRE : le brouillon s'il existe, sinon la version en ligne (miroir de `grapheEditable`). */
export function grapheEditable(w: WorkflowSummary): WorkflowGraph {
  // ⚠️ À n'appeler QUE sur un scénario venu de `getWorkflow(id)`. La LISTE ne porte plus de graphe, et un
  // repli sur un graphe vide est plus honnête qu'un plantage : l'écran d'édition, seul appelant, charge
  // toujours le détail avant d'ouvrir.
  return w.draftGraph ?? w.graph ?? { nodes: [], edges: [] };
}
/**
 * Ce scénario a-t-il quelque chose EN LIGNE ? Un scénario jamais publié n'a pas de version publiée, donc
 * rien ne s'exécute quand on le déclenche.
 *
 * 🔴 À afficher partout où l'on CHOISIT un scénario à déclencher (automation, webhook entrant, lancement
 * depuis l'inbox). Sans ça, on peut brancher une automation sur un scénario jamais publié : elle se
 * déclencherait normalement et ne ferait rien, sans le moindre message. C'est le seul piège que le brouillon
 * introduit, et il se ferme au moment du choix.
 */
export function estEnLigne(w: WorkflowSummary): boolean {
  // La LISTE ne porte plus de graphe : elle donne le nombre de blocs, calculé en base. On le lit d'abord.
  if (typeof w.nodeCount === 'number') return w.nodeCount > 0;
  // Lecture DÉFENSIVE, comme partout où l'on touche une réponse d'API : ce helper est appelé depuis trois
  // écrans qui ne demandent au scénario que son nom (automations, webhooks, inbox). Une réponse sans `graph`
  // ferait tomber la page ENTIÈRE sur un `.nodes` d'undefined, pour un simple libellé. Vu le 2026-09-01 :
  // 19 tests e2e des webhooks rouges d'un coup.
  return Array.isArray(w.graph?.nodes) && w.graph.nodes.length > 0;
}
/**
 * Éprouve une « Fonction JS » sur une valeur d'essai.
 *
 * ⚠️ LE MÊME BAC À SABLE QUE L'EXÉCUTION, côté serveur : un essai qui réussirait là où le parcours échoue
 * serait pire que pas d'essai du tout. Le résultat arrive toujours en 200, échec compris : la faute du
 * client est le RÉSULTAT de l'essai, pas une panne de la route.
 */
export function essayerFonctionJs(tenantId: string, code: string, valeur: string): Promise<EssaiJs> {
  return request<EssaiJs>(`/tenants/${tenantId}/workflows/js-test`, {
    method: 'POST', body: JSON.stringify({ code, valeur }),
  });
}

export function listWorkflows(tenantId: string): Promise<{ workflows: WorkflowSummary[] }> {
  return request<{ workflows: WorkflowSummary[] }>(`/tenants/${tenantId}/workflows`);
}
export function createWorkflow(tenantId: string, name: string, graph?: WorkflowGraph): Promise<{ id: string; name: string; graph: WorkflowGraph }> {
  return request(`/tenants/${tenantId}/workflows`, { method: 'POST', body: JSON.stringify({ name, ...(graph ? { graph } : {}) }) });
}
export function getWorkflow(tenantId: string, id: string): Promise<{ workflow: WorkflowSummary }> {
  return request<{ workflow: WorkflowSummary }>(`/tenants/${tenantId}/workflows/${id}`);
}
/**
 * Enregistre le BROUILLON du scénario (jamais la version en ligne, cf. `publishWorkflow`).
 *
 * `brouillon` dans la réponse = reste-t-il quelque chose à publier après cette écriture ? La question se pose
 * au serveur parce qu'un enregistrement identique à la version en ligne n'y laisse aucun brouillon.
 */
export function updateWorkflow(tenantId: string, id: string, patch: { name?: string; graph?: WorkflowGraph }, opts?: { keepalive?: boolean }): Promise<{ brouillon?: boolean }> {
  // `keepalive` : la requête survit au déchargement de la page (flush auto-save sur beforeunload / fermeture d'onglet).
  return request(`/tenants/${tenantId}/workflows/${id}`, { method: 'PATCH', body: JSON.stringify(patch), ...(opts?.keepalive ? { keepalive: true } : {}) });
}
export function deleteWorkflow(tenantId: string, id: string): Promise<unknown> {
  return request(`/tenants/${tenantId}/workflows/${id}`, { method: 'DELETE' });
}
/**
 * MET EN LIGNE le brouillon. C'est le seul appel du front qui change quelque chose pour les contacts : tout
 * le reste de l'éditeur n'écrit que le brouillon.
 *
 * ⚠️ Sans retour arrière : la version précédente n'est conservée nulle part.
 */
export function publishWorkflow(tenantId: string, id: string): Promise<{ id: string; graph: WorkflowGraph; publishedAt: string | null }> {
  return request(`/tenants/${tenantId}/workflows/${id}/publish`, { method: 'POST', body: JSON.stringify({}) });
}
/** Duplique un scénario (nom « X (copie) », graphe cloné avec codes de node frais). Renvoie le nouveau scénario. */
export function duplicateWorkflow(tenantId: string, id: string): Promise<{ id: string; name: string; graph: WorkflowGraph }> {
  return request(`/tenants/${tenantId}/workflows/${id}/duplicate`, { method: 'POST', body: JSON.stringify({}) });
}

/** Un bloc (node) aplati depuis les scénarios, pour la page Contenu > Blocs. `code` = nod_... ou null. */
export interface NodeListItem {
  code: string | null;
  type: WorkflowNodeType;
  /** Nom libre du bloc (data.name), vide si non renseigné. */
  name: string;
  workflowId: string;
  workflowName: string;
  summary: string;
}
/** Liste tous les blocs des scénarios du tenant, optionnellement filtrés par type. */
export function listNodes(tenantId: string, type?: WorkflowNodeType): Promise<{ nodes: NodeListItem[] }> {
  const qs = type ? `?type=${encodeURIComponent(type)}` : '';
  return request<{ nodes: NodeListItem[] }>(`/tenants/${tenantId}/nodes${qs}`);
}

// --- Contenu : Tags + User fields (édition) ---

export interface TagCount {
  tag: string;
  count: number;
  /** Code public « tag_<client>_<ulid> » (schéma A). null pour un tag utilisé mais jamais déclaré, ou avant backfill. */
  code?: string | null;
}
export function listTags(tenantId: string): Promise<{ tags: TagCount[] }> {
  return request<{ tags: TagCount[] }>(`/tenants/${tenantId}/tags`);
}
export function createTag(tenantId: string, name: string): Promise<{ name: string; created: boolean }> {
  return request(`/tenants/${tenantId}/tags`, { method: 'POST', body: JSON.stringify({ name }) });
}
export function renameTag(tenantId: string, from: string, to: string): Promise<{ renamed: number }> {
  return request(`/tenants/${tenantId}/tags`, { method: 'PATCH', body: JSON.stringify({ from, to }) });
}
export function deleteTag(tenantId: string, tag: string): Promise<{ removed: number }> {
  return request(`/tenants/${tenantId}/tags?tag=${encodeURIComponent(tag)}`, { method: 'DELETE' });
}
