import { walk, entryNode, nextNode, nextNodeByHandle } from './engine';
import type { WorkflowAction, WalkRest, WorkflowButton } from './engine';
import type { WorkflowGraph } from './graph';
import type { RunState, WorkflowRunRow } from './run-store.pg';

export interface WorkflowExecutorDeps {
  runs: {
    start(tenantId: string, workflowId: string, waId: string, contactId: string | null, state: RunState): Promise<{ id: string }>;
    findWaitingByWaId(tenantId: string, waId: string): Promise<WorkflowRunRow | null>;
    setState(id: string, state: RunState): Promise<void>;
  };
  getGraph(workflowId: string, tenantId: string): Promise<WorkflowGraph | null>;
  applyTag(tenantId: string, waId: string, tag: string): Promise<void>;
  setField(tenantId: string, waId: string, key: string, value: string): Promise<void>;
  /**
   * `buttons` = boutons du template (pour poser un payload contrôlé sur les quick-reply : branche par bouton).
   * `explicitParams` (optionnel) = variables du corps DÉJÀ résolues (campagne workflow, 1er template) : si fourni,
   * l'envoi utilise ces valeurs directement au lieu de re-résoudre via les hints. Absent (advance/webhook) ->
   * comportement inchangé (hints stockés).
   */
  sendTemplate(tenantId: string, waId: string, templateName: string, language: string, buttons: WorkflowButton[], explicitParams?: string[]): Promise<void>;
  /** Envoie un message interactif (texte + 2-3 réponses rapides) hors template. Atteint uniquement via `advance`
   *  (après réponse du contact), donc toujours dans la fenêtre de service 24 h. */
  sendQuickMessage(tenantId: string, waId: string, body: string, buttons: WorkflowButton[]): Promise<void>;
}

function restToState(rest: WalkRest): RunState {
  if (rest.status === 'waiting') return { currentNode: rest.nodeId, status: 'waiting' };
  if (rest.status === 'inbox') return { currentNode: null, status: 'inbox' };
  return { currentNode: null, status: 'done' };
}

/**
 * Orchestre l'exécution d'un workflow (applique les actions du moteur PUR + persiste l'état du run). IO
 * injectée (contact store, envoi Meta, run store) -> testable sans DB/réseau. `start` : démarre un run pour
 * un contact (PB3 : lancé par une campagne). `advance` : fait avancer le run en attente quand le contact
 * répond (branché sur le webhook). Idempotent par message (dédup at-least-once).
 */
export class WorkflowExecutor {
  constructor(private readonly deps: WorkflowExecutorDeps) {}

  /**
   * `firstTemplateParams` (optionnel) : variables du corps déjà résolues, transmises à l'envoi de template. Un
   * `walk` depuis un seul point d'entrée s'arrête au 1er bloc template/flow (bloquant) -> il produit AU PLUS une
   * action `sendTemplate`, donc ces params ne s'appliquent qu'à ce 1er envoi (jamais à un template ultérieur).
   */
  private async apply(tenantId: string, waId: string, actions: WorkflowAction[], firstTemplateParams?: string[]): Promise<void> {
    for (const a of actions) {
      if (a.kind === 'tag') await this.deps.applyTag(tenantId, waId, a.tag);
      else if (a.kind === 'field') await this.deps.setField(tenantId, waId, a.key, a.value);
      else if (a.kind === 'sendQuickMessage') await this.deps.sendQuickMessage(tenantId, waId, a.body, a.buttons);
      else await this.deps.sendTemplate(tenantId, waId, a.templateName, a.language, a.buttons, firstTemplateParams);
    }
  }

  /**
   * Démarre un run : parcourt depuis l'entrée, applique les actions, persiste l'état (sauf 100% synchrone -> done).
   * `firstTemplateParams` (campagne workflow) = variables du 1er template déjà résolues par contact -> passées à
   * l'envoi du 1er template SANS re-résolution via les hints stockés.
   */
  async start(tenantId: string, workflowId: string, graph: WorkflowGraph, contact: { waId: string; contactId: string | null }, firstTemplateParams?: string[]): Promise<void> {
    const entry = entryNode(graph);
    if (!entry) return;
    const { actions, rest } = walk(graph, entry);
    await this.apply(tenantId, contact.waId, actions, firstTemplateParams);
    const state = restToState(rest);
    if (state.status !== 'done') await this.deps.runs.start(tenantId, workflowId, contact.waId, contact.contactId, state);
  }

  /**
   * Avance le run en attente d'un contact quand il répond. No-op si aucun run / message déjà traité.
   * `buttonPayload` = bouton quick-reply tapé (`btn:<index>`) : si une arête part de ce handle on la suit
   * (branche par bouton), sinon on retombe sur la 1re arête sortante (réponse texte, ou bouton non câblé).
   */
  async advance(tenantId: string, waId: string, messageId: string, buttonPayload: string | null = null): Promise<void> {
    const run = await this.deps.runs.findWaitingByWaId(tenantId, waId);
    if (!run || run.lastMessageId === messageId) return; // dédup at-least-once
    const graph = run.currentNode ? await this.deps.getGraph(run.workflowId, tenantId) : null;
    const next = graph && run.currentNode
      ? ((buttonPayload ? nextNodeByHandle(graph, run.currentNode, buttonPayload) : null) ?? nextNode(graph, run.currentNode))
      : null;
    if (!graph || !next) {
      await this.deps.runs.setState(run.id, { currentNode: null, status: 'done', lastMessageId: messageId });
      return;
    }
    const { actions, rest } = walk(graph, next);
    await this.apply(tenantId, waId, actions);
    await this.deps.runs.setState(run.id, { ...restToState(rest), lastMessageId: messageId });
  }
}
