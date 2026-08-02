import type { WorkflowGraph, WorkflowNode } from './graph';
import { evaluateConditionGroup, coerceConditionGroup } from './conditions';
import type { EvalContext } from './conditions';

/**
 * Moteur d'exécution d'un workflow, PUR (aucune IO). Un run avance en LIGNE DROITE : on suit la 1re arête
 * sortante de chaque bloc. Les blocs SYNCHRONES (tag/field) produisent une action et on continue ; un bloc
 * `template`/`flow` produit son action puis ATTEND une réponse du contact ; `inbox` est terminal (remontée
 * humaine). V1 volontairement simple : pas de branche par bouton (réservé plus tard via sourceHandle).
 */

/** Bouton d'un template (dénormalisé sur le node à la sélection) : sert à envoyer un payload contrôlé par
 *  bouton quick-reply (branche déterministe) et à afficher les sorties dans l'éditeur. */
export interface WorkflowButton { type: string; text: string }

export type WorkflowAction =
  | { kind: 'tag'; tag: string }
  | { kind: 'field'; key: string; value: string }
  | { kind: 'sendTemplate'; templateName: string; language: string; buttons: WorkflowButton[] }
  | { kind: 'sendQuickMessage'; body: string; buttons: WorkflowButton[] }
  | { kind: 'sendFlow'; flowId: string; flowName: string; body: string; cta: string };

/** Actions qui envoient un message de SESSION (hors template) : interdites en OUVERTURE de scénario, une
 *  campagne démarre hors fenêtre de service 24 h (Meta 131047). Seul un template peut ouvrir. */
export function opensOutsideServiceWindow(graph: WorkflowGraph): boolean {
  const entry = entryNode(graph);
  if (!entry) return false;
  // Branch-aware : un bloc `condition` a DEUX sorties (Oui/Sinon) ; l'une comme l'autre peut mener à une
  // ouverture par message de session. On explore donc TOUTES les branches atteignables depuis l'entrée avant
  // le 1er bloc bloquant (template = ouverture légale et bloquant -> on s'arrête ; inbox = terminal).
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack: string[] = [entry];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (node.type === 'inbox' || node.type === 'template') continue; // terminal / ouverture légale : on n'explore pas au-delà
    if (node.type === 'flow' || node.type === 'quick_message') {
      const a = actionOf(node);
      if (a && (a.kind === 'sendFlow' || a.kind === 'sendQuickMessage')) return true; // ouverture par message de session
      continue; // bloc bloquant NON configuré (pas d'action) : pas une ouverture, et on ne va pas au-delà
    }
    if (node.type === 'condition') {
      const t = nextNodeByHandle(graph, id, 'true');
      const f = nextNodeByHandle(graph, id, 'false') ?? nextNode(graph, id);
      if (t) stack.push(t);
      if (f) stack.push(f);
      continue;
    }
    // tag / field : bloc synchrone -> explorer la suite
    const nx = nextNode(graph, id);
    if (nx) stack.push(nx);
  }
  return false;
}

export type WalkRest =
  | { status: 'waiting'; nodeId: string } // en attente d'une réponse (après un template ou un formulaire)
  | { status: 'inbox' } // conversation remontée à l'humain (terminal)
  | { status: 'done' }; // fin de chaîne (plus d'arête sortante)

export interface WalkResult {
  actions: WorkflowAction[];
  rest: WalkRest;
}

/** Bloc d'entrée d'un workflow = un bloc SANS arête entrante (racine). Défaut : le 1er bloc. null si vide. */
export function entryNode(graph: WorkflowGraph): string | null {
  if (graph.nodes.length === 0) return null;
  const hasIncoming = new Set(graph.edges.map((e) => e.target));
  const root = graph.nodes.find((n) => !hasIncoming.has(n.id));
  return (root ?? graph.nodes[0]!).id;
}

/** Le bloc suivant (cible de la 1re arête sortante). null s'il n'y en a pas. */
export function nextNode(graph: WorkflowGraph, nodeId: string): string | null {
  return graph.edges.find((e) => e.source === nodeId)?.target ?? null;
}

/** Le bloc suivant POUR un handle de sortie donné (branche par bouton : sourceHandle = `btn:<index>`).
 *  null si aucune arête ne part de ce handle. */
export function nextNodeByHandle(graph: WorkflowGraph, nodeId: string, handle: string): string | null {
  return graph.edges.find((e) => e.source === nodeId && e.sourceHandle === handle)?.target ?? null;
}

function actionOf(node: WorkflowNode, ctx?: EvalContext): WorkflowAction | null {
  if (node.type === 'tag') {
    const tag = String(node.data.tag ?? '').trim();
    return tag ? { kind: 'tag', tag } : null;
  }
  if (node.type === 'field') {
    const key = String(node.data.fieldKey ?? node.data.key ?? '').trim();
    if (!key) return null;
    // NOW : le bloc peut poser l'horodatage COURANT (ISO UTC absolu, comparable par une condition datetime) au
    // lieu d'une valeur fixe. Sans contexte (analyse de graphe pure, ctx absent) la valeur est vide (non exécutée).
    const value = node.data.valueKind === 'now' ? (ctx ? ctx.now.toISOString() : '') : String(node.data.value ?? '');
    return { kind: 'field', key, value };
  }
  if (node.type === 'template') {
    const templateName = String(node.data.templateName ?? '').trim();
    if (!templateName) return null;
    const raw = Array.isArray(node.data.templateButtons) ? node.data.templateButtons : [];
    const buttons: WorkflowButton[] = raw.map((b) => ({
      type: String((b as { type?: unknown }).type ?? ''),
      text: String((b as { text?: unknown }).text ?? ''),
    }));
    return { kind: 'sendTemplate', templateName, language: String(node.data.language ?? 'fr'), buttons };
  }
  if (node.type === 'flow') {
    // Node « formulaire » : envoie le flow en message interactif (hors template). Sans flowId -> null
    // (no-op waiting), même contrat qu'un template sans templateName. `body` = accroche du message,
    // `cta` = libellé du bouton d'ouverture (pré-rempli avec le cta du formulaire à la sélection).
    const flowId = String(node.data.flowId ?? '').trim();
    if (!flowId) return null;
    const flowName = String(node.data.flowName ?? '').trim();
    const body = String(node.data.body ?? '').trim() || (flowName ? `Formulaire : ${flowName}` : 'Formulaire à remplir');
    const cta = String(node.data.cta ?? '').trim().slice(0, 30) || 'Envoyer';
    return { kind: 'sendFlow', flowId, flowName, body, cta };
  }
  if (node.type === 'quick_message') {
    const body = String(node.data.body ?? '').trim();
    // Les réponses rapides gardent leur ORDRE (index = handle btn:<i> pour la branche) : on ne filtre PAS ici,
    // la couche d'envoi filtre les vides en préservant l'index. Bloc incomplet (pas de corps ou aucune réponse
    // non vide) -> null (no-op), comme un template sans templateName.
    const raw = Array.isArray(node.data.quickReplies) ? node.data.quickReplies : [];
    const buttons: WorkflowButton[] = raw.map((q) => ({ type: 'QUICK_REPLY', text: String(q ?? '') }));
    if (!body || !buttons.some((b) => b.text.trim() !== '')) return null;
    return { kind: 'sendQuickMessage', body, buttons };
  }
  return null;
}

/**
 * Parcourt le graphe depuis `startNodeId` : accumule les actions des blocs synchrones, s'arrête au 1er bloc
 * bloquant (template/flow -> waiting, inbox -> inbox) ou en fin de chaîne (done). Anti-cycle : un bloc déjà
 * visité arrête le parcours (done). Un `startNodeId` inconnu -> done sans action.
 */
/** Répercute une action SYNCHRONE (tag/field) sur la copie de travail du contexte, pour qu'une condition
 *  rencontrée plus loin dans le MÊME walk la voie (l'écriture en base n'a lieu qu'après, via executor.apply).
 *  Même normalisation de tag que le worker (trim + slice 64, dédup). */
function applyToWork(work: EvalContext, a: WorkflowAction): void {
  if (a.kind === 'tag') {
    const t = a.tag.trim().slice(0, 64);
    if (t !== '' && !work.tags.includes(t)) work.tags.push(t);
  } else if (a.kind === 'field') {
    work.fields[a.key] = a.value;
  }
}

export function walk(graph: WorkflowGraph, startNodeId: string, ctx?: EvalContext): WalkResult {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const actions: WorkflowAction[] = [];
  const visited = new Set<string>();
  // Copie de travail MUTABLE du contexte : une action tag/field décidée dans CE walk (appliquée en base seulement
  // APRÈS, via executor.apply) doit être visible par une condition rencontrée plus loin dans la MÊME chaîne
  // synchrone. Sans ça, Field(NOW) -> Condition(datetime not_empty) évaluerait contre l'état d'AVANT le field.
  const work: EvalContext | undefined = ctx ? { ...ctx, tags: [...ctx.tags], fields: { ...ctx.fields } } : undefined;
  let current: string | null = startNodeId;

  while (current) {
    if (visited.has(current)) return { actions, rest: { status: 'done' } };
    visited.add(current);
    const node = byId.get(current);
    if (!node) return { actions, rest: { status: 'done' } };

    if (node.type === 'inbox') return { actions, rest: { status: 'inbox' } };
    if (node.type === 'condition') {
      // Bloc SYNCHRONE sans action : évalue la condition (copie de travail) et suit la sortie 'true' (« Si réunie »)
      // ou 'false' (« Sinon »). Sans contexte (analyse de graphe pure) -> 'false' DÉTERMINISTE. Anti-cycle via visited.
      const here: string = current;
      const passed = work ? evaluateConditionGroup(coerceConditionGroup(node.data), work) : false;
      // Sorties TYPÉES : si la branche évaluée n'est pas câblée alors qu'AU MOINS une sortie typée ('true'/'false')
      // existe -> cul-de-sac (done), JAMAIS l'arête de l'autre branche. Repli sur la 1re arête uniquement pour un
      // node SANS aucune sortie typée (graphe legacy/non branché). Sinon `?? nextNode` volerait l'autre sortie.
      const hasTypedEdge = graph.edges.some((e) => e.source === here && (e.sourceHandle === 'true' || e.sourceHandle === 'false'));
      current = nextNodeByHandle(graph, here, passed ? 'true' : 'false') ?? (hasTypedEdge ? null : nextNode(graph, here));
      continue;
    }
    if (node.type === 'template' || node.type === 'flow' || node.type === 'quick_message') {
      const a = actionOf(node, work);
      if (a) actions.push(a);
      return { actions, rest: { status: 'waiting', nodeId: current } };
    }
    // tag / field : bloc synchrone -> action + on continue. On répercute l'effet dans la copie de travail.
    const a = actionOf(node, work);
    if (a) {
      actions.push(a);
      if (work) applyToWork(work, a);
    }
    current = nextNode(graph, current);
  }
  return { actions, rest: { status: 'done' } };
}
