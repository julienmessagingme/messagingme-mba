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
  | { kind: 'removeTag'; tag: string }
  | { kind: 'field'; key: string; value: string }
  | { kind: 'clearField'; key: string }
  | { kind: 'sendTemplate'; templateName: string; language: string; buttons: WorkflowButton[] }
  | { kind: 'sendQuickMessage'; body: string; buttons: WorkflowButton[] }
  | { kind: 'sendFlow'; flowId: string; flowName: string; body: string; cta: string };

/** Ce que l'OUVERTURE d'un scénario contient, en un seul parcours (les deux questions posées sur l'ouverture
 *  ont la même exploration : les séparer en deux fonctions dupliquerait la traversée ET ses règles). */
export interface OpeningScan {
  /** Un message de SESSION (message rapide / formulaire) part-il avant tout template ? */
  sessionOpen: boolean;
  /** Le 1er template atteignable (parcours en LARGEUR : l'ordre reflète la proximité de l'entrée). */
  firstTemplate: WorkflowNode | null;
  /** Plusieurs templates DIFFÉRENTS peuvent ouvrir (branches d'une condition) -> aucune ouverture unique. */
  ambiguousTemplate: boolean;
  /** Une ATTENTE est traversée avant le 1er template : rien ne part au lancement. */
  waitBeforeTemplate: boolean;
  /** Un template d'ouverture atteint n'a PAS de nom : sur cette branche, rien ne partirait, et le destinataire
   *  serait pourtant compté « envoyé ». Distinct de `firstTemplate === null` (aucun template du tout). */
  unnamedOpeningTemplate: boolean;
}

/**
 * Explore, depuis l'entrée, tout ce qui est atteignable AVANT le premier envoi. Les blocs synchrones
 * (tag / field / action) sont traversés, un bloc `condition` explore ses DEUX sorties, `template` et `inbox`
 * arrêtent l'exploration de leur branche.
 *
 * En LARGEUR (file, pas pile) : « le premier template » doit être le plus proche de l'entrée, sinon le mapping
 * de variables d'une campagne viserait un template arbitraire selon l'ordre d'insertion des blocs.
 */
export function scanOpening(graph: WorkflowGraph): OpeningScan {
  const out: OpeningScan = { sessionOpen: false, firstTemplate: null, ambiguousTemplate: false, waitBeforeTemplate: false, unnamedOpeningTemplate: false };
  const entry = entryNode(graph);
  if (!entry) return out;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const queue: string[] = [entry];
  const noms = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (node.type === 'inbox') continue; // terminal
    if (node.type === 'template') {
      // Ouverture légale et bloquante : on ne va pas au-delà. Deux branches qui ouvrent sur des templates de
      // noms différents rendent l'ouverture ambiguë (quel template la campagne devrait-elle paramétrer ?).
      const nom = String(node.data.templateName ?? '').trim();
      if (nom !== '') noms.add(nom);
      else out.unnamedOpeningTemplate = true;
      if (!out.firstTemplate) out.firstTemplate = node;
      out.ambiguousTemplate = noms.size > 1;
      continue;
    }
    if (node.type === 'flow' || node.type === 'quick_message') {
      const a = actionOf(node);
      if (a && (a.kind === 'sendFlow' || a.kind === 'sendQuickMessage')) out.sessionOpen = true;
      continue; // bloc bloquant NON configuré (pas d'action) : pas une ouverture, et on ne va pas au-delà
    }
    if (node.type === 'wait') out.waitBeforeTemplate = true; // traversé, mais rien ne partira au lancement
    if (node.type === 'condition') {
      const t = nextNodeByHandle(graph, id, 'true');
      const f = nextNodeByHandle(graph, id, 'false') ?? nextNode(graph, id);
      if (t) queue.push(t);
      if (f) queue.push(f);
      continue;
    }
    // tag / field / action / wait : bloc synchrone -> explorer la suite
    const nx = nextNode(graph, id);
    if (nx) queue.push(nx);
  }
  return out;
}

/** Un montage impossible : une attente qui ferme forcément la fenêtre, suivie d'un message de session. */
export interface WaitThenSession {
  /** Le dernier bloc Attente TRAVERSÉ sur ce chemin (celui qu'on montre à l'utilisateur). */
  waitNodeId: string;
  /** Le bloc message rapide / formulaire qui ne partira jamais. */
  messageNodeId: string;
}

/**
 * Cherche un chemin « attente cumulée >= 24 h, PUIS message rapide ou formulaire ».
 *
 * Ce montage ne peut jamais marcher : la fenêtre de service court depuis le dernier message DU CONTACT, donc
 * après 24 h d'attente elle est fermée à coup sûr, et Meta refuse tout message hors template (131047). Le
 * runtime le bloque déjà (`executor.resume`) ; cette fonction sert à le DIRE dans le builder, au moment où on
 * le construit, plutôt que de laisser découvrir le silence en production.
 *
 * Sous 24 h on ne dit rien : la fenêtre PEUT être encore ouverte (le contact a pu écrire entre-temps), c'est
 * au runtime de trancher sur l'état réel, pas à une analyse de graphe de deviner.
 *
 * Termine sur les graphes CYCLIQUES : le cumul est PLAFONNÉ à 24 h (au-delà, la réponse ne change plus), et un
 * bloc n'est ré-exploré que si on l'atteint avec un cumul strictement plus grand. Sans ce plafond, un cycle
 * d'attentes ferait croître le cumul indéfiniment et la fonction ne rendrait jamais la main.
 */
export function waitBeforeSessionMessage(graph: WorkflowGraph): WaitThenSession | null {
  const FENETRE_MS = 24 * 3_600_000;
  // Chaque attente compte pour au MOINS un pas de balayage (60 s), la granularité réelle d'un réveil. Sans ce
  // plancher, un délai fractionnaire enregistré par l'API (`{delay: 0.001}`, 60 ms) dans un cycle demanderait
  // ~1,4 million d'itérations par bloc et figerait l'onglet.
  const PAS_MIN_MS = 60_000;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const entry = entryNode(graph);
  if (!entry) return null;
  const meilleur = new Map<string, number>();
  // pile de { bloc, attente cumulée jusqu'ici, dernier bloc Attente franchi }
  const pile: Array<{ id: string; cumul: number; dernierWait: string | null }> = [{ id: entry, cumul: 0, dernierWait: null }];
  while (pile.length > 0) {
    const { id, cumul, dernierWait } = pile.pop()!;
    const vu = meilleur.get(id);
    if (vu !== undefined && vu >= cumul) continue;
    meilleur.set(id, cumul);
    const node = byId.get(id);
    if (!node) continue;
    if (node.type === 'inbox') continue;
    if (node.type === 'flow' || node.type === 'quick_message') {
      const a = actionOf(node);
      if (a && (a.kind === 'sendFlow' || a.kind === 'sendQuickMessage') && cumul >= FENETRE_MS && dernierWait) {
        return { waitNodeId: dernierWait, messageNodeId: id };
      }
      continue; // bloc bloquant : on n'explore pas au-delà
    }
    // Un TEMPLATE remet le compteur à zéro. Attention à la raison : un template n'OUVRE PAS la fenêtre de
    // service (seul un message DU CONTACT l'ouvre). Le parcours s'ARRÊTE au template jusqu'à la réponse, et
    // c'est cette réponse qui rouvre la fenêtre : l'attente d'avant ne pèse donc plus sur la suite.
    const suivant = node.type === 'template'
      ? { cumul: 0, dernierWait: null }
      : node.type === 'wait'
        ? { cumul: Math.min(cumul + Math.max(PAS_MIN_MS, waitDurationMs(node)), FENETRE_MS), dernierWait: waitDurationMs(node) > 0 ? id : dernierWait }
        : { cumul, dernierWait };
    if (node.type === 'condition') {
      for (const h of ['true', 'false'] as const) {
        const cible = nextNodeByHandle(graph, id, h);
        if (cible) pile.push({ id: cible, ...suivant });
      }
      const repli = nextNode(graph, id);
      if (repli && !graph.edges.some((e) => e.source === id && (e.sourceHandle === 'true' || e.sourceHandle === 'false'))) {
        pile.push({ id: repli, ...suivant });
      }
      continue;
    }
    const nx = nextNode(graph, id);
    if (nx) pile.push({ id: nx, ...suivant });
  }
  return null;
}

/** Actions qui envoient un message de SESSION (hors template) : interdites en OUVERTURE de scénario, une
 *  campagne démarre hors fenêtre de service 24 h (Meta 131047). Seul un template peut ouvrir. */
export function opensOutsideServiceWindow(graph: WorkflowGraph): boolean {
  return scanOpening(graph).sessionOpen;
}

export type WalkRest =
  | { status: 'waiting'; nodeId: string } // en attente d'une RÉPONSE du contact (après un template ou un formulaire)
  | { status: 'sleeping'; nodeId: string; resumeInMs: number } // en attente du TEMPS qui passe (bloc Attente)
  | { status: 'inbox' } // conversation remontée à l'humain (terminal)
  | { status: 'done' }; // fin de chaîne (plus d'arête sortante)

/** Unités proposées par le bloc Attente. */
export const WAIT_UNITS = ['minutes', 'hours', 'days'] as const;
export type WaitUnit = (typeof WAIT_UNITS)[number];
const UNIT_MS: Record<WaitUnit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
/** Plafond : 30 jours. Au-delà, un parcours dormant n'a plus de sens métier et la fenêtre est fermée depuis
 *  longtemps ; borner évite aussi une échéance absurde posée par une saisie erronée. */
export const WAIT_MAX_MS = 30 * 86_400_000;

/**
 * Durée d'un bloc Attente, en millisecondes. 0 = bloc NON configuré (durée absente, nulle, négative ou unité
 * inconnue) : il se comporte alors en passe-plat, on ne bloque pas un parcours sur une saisie oubliée.
 */
export function waitDurationMs(node: WorkflowNode): number {
  const brut = Number(node.data.delay ?? node.data.value ?? 0);
  if (!Number.isFinite(brut) || brut <= 0) return 0;
  const unit = String(node.data.unit ?? 'hours') as WaitUnit;
  const ms = UNIT_MS[unit];
  if (!ms) return 0;
  return Math.min(Math.round(brut * ms), WAIT_MAX_MS);
}

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
  if (node.type === 'action') {
    // Bloc unifié : la sous-action est portée par `data.actionKind`. add_tag/set_field produisent les MÊMES
    // actions que les blocs legacy tag/field ; remove_tag/clear_field sont les nouveaux retraits. Bloc incomplet
    // (tag/clé vide) -> null (no-op), comme les autres blocs.
    const kind = String(node.data.actionKind ?? '');
    const tag = String(node.data.tag ?? '').trim();
    const key = String(node.data.fieldKey ?? node.data.key ?? '').trim();
    if (kind === 'add_tag') return tag ? { kind: 'tag', tag } : null;
    if (kind === 'remove_tag') return tag ? { kind: 'removeTag', tag } : null;
    if (kind === 'set_field') {
      if (!key) return null;
      const value = node.data.valueKind === 'now' ? (ctx ? ctx.now.toISOString() : '') : String(node.data.value ?? '');
      return { kind: 'field', key, value };
    }
    if (kind === 'clear_field') return key ? { kind: 'clearField', key } : null;
    return null;
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
  // MBA (envoi vers MBA / désactivation) : PRÉ-CÂBLAGE INERTE. Aucune action tant que MBA n'est pas actif
  // (agent_eligibility 403). `null` = no-op synchrone : `walk` traverse le bloc comme un tag/field vide et
  // continue. On ne pose JAMAIS `control_owner='mba'` ici (réservé au webhook messaging_handovers), et aucun
  // appel thread_control n'est branché : ce sont des placeholders, câblés le jour de l'activation MBA.
  if (node.type === 'mba_handoff' || node.type === 'mba_disable') return null;
  return null;
}

/**
 * Parcourt le graphe depuis `startNodeId` : accumule les actions des blocs synchrones, s'arrête au 1er bloc
 * bloquant (template/flow -> waiting, inbox -> inbox) ou en fin de chaîne (done). Anti-cycle : un bloc déjà
 * visité arrête le parcours (done). Un `startNodeId` inconnu -> done sans action.
 */
/** Répercute une action SYNCHRONE (tag/field, ajout OU retrait) sur la copie de travail du contexte, pour qu'une
 *  condition rencontrée plus loin dans le MÊME walk la voie (l'écriture en base n'a lieu qu'après, via
 *  executor.apply). Même normalisation de tag que le worker (trim + slice 64, dédup). `clearField` retire la clé
 *  (une condition `champ vide` en aval doit voir le champ absent, comme le SQL `fields - key`). */
function applyToWork(work: EvalContext, a: WorkflowAction): void {
  if (a.kind === 'tag') {
    const t = a.tag.trim().slice(0, 64);
    if (t !== '' && !work.tags.includes(t)) work.tags.push(t);
  } else if (a.kind === 'removeTag') {
    const t = a.tag.trim().slice(0, 64);
    work.tags = work.tags.filter((x) => x !== t);
  } else if (a.kind === 'field') {
    work.fields[a.key] = a.value;
  } else if (a.kind === 'clearField') {
    delete work.fields[a.key];
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
    if (node.type === 'wait') {
      // Bloc ATTENTE : il n'agit pas, il met le parcours en sommeil jusqu'à l'échéance. Les actions déjà
      // accumulées partent MAINTENANT ; la suite reprendra depuis ce bloc (le sweeper repart de son successeur).
      const ms = waitDurationMs(node);
      if (ms > 0) return { actions, rest: { status: 'sleeping', nodeId: current, resumeInMs: ms } };
      current = nextNode(graph, current); // durée non configurée -> passe-plat
      continue;
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
