import { walk, entryNode, nextNode, nextNodeByHandle } from './engine';
import type { WorkflowAction, WalkRest, WorkflowButton } from './engine';
import type { WorkflowGraph } from './graph';
import type { EvalContext } from './conditions';
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
  /** Retire un tag du contact (bloc Action « retirer un tag »). */
  removeTag(tenantId: string, waId: string, tag: string): Promise<void>;
  /** Vide un champ du contact = retire la clé (bloc Action « vider un champ »). */
  clearField(tenantId: string, waId: string, key: string): Promise<void>;
  /**
   * `buttons` = boutons du template (pour poser un payload contrôlé sur les quick-reply : branche par bouton).
   * `explicitParams` (optionnel) = variables du corps DÉJÀ résolues (campagne workflow, 1er template) : si fourni,
   * l'envoi utilise ces valeurs directement au lieu de re-résoudre via les hints. Absent (advance/webhook) ->
   * comportement inchangé (hints stockés).
   */
  sendTemplate(tenantId: string, waId: string, templateName: string, language: string, buttons: WorkflowButton[], explicitParams?: string[]): Promise<void>;
  /** Envoie un message interactif (texte + 2-3 réponses rapides) hors template. Atteint via `advance` (après
   *  réponse du contact) ou `startFromNode` (fenêtre vérifiée par l'appelant) : toujours EN fenêtre 24 h. */
  sendQuickMessage(tenantId: string, waId: string, body: string, buttons: WorkflowButton[]): Promise<void>;
  /** Envoie un formulaire (message interactif type flow) hors template. Même contrainte de fenêtre 24 h que
   *  sendQuickMessage : la garde de `start` refuse un scénario qui OUVRE sur un flow/quick_message, et
   *  `startFromNode` n'est appelé qu'après vérification de la fenêtre destinataire par destinataire. */
  sendFlow(tenantId: string, waId: string, flowId: string, body: string, cta: string): Promise<void>;
  /**
   * Le scénario a-t-il le droit d'écrire dans ce fil ? false dès qu'un opérateur (`app_human`) ou l'agent
   * de Meta (`mba`) le détient. OPTIONNEL : absent, tout est permis, ce qui préserve le comportement des
   * suites de tests qui construisent des deps minimales. En production il est toujours câblé.
   */
  mayAct?(tenantId: string, waId: string): Promise<boolean>;
  /**
   * Construit le CONTEXTE d'évaluation d'un contact (état contact : fields/tags/opt-in/attributs + fuseau &
   * horaires du tenant + `now`) pour les blocs `condition` et le bloc `field` en mode NOW. OPTIONNEL : absent,
   * les conditions prennent la branche 'false' DÉTERMINISTE et un bloc field NOW pose une valeur vide -> préserve
   * les suites de tests à deps minimales. Renvoie null si le contact est introuvable -> même repli 'false'.
   */
  evalContext?(tenantId: string, waId: string): Promise<EvalContext | null>;
  /**
   * Le run vient d'atteindre un bloc `inbox` : la conversation passe à un humain (control_owner=app_human).
   * Sans ça, atteindre le bloc inbox n'était qu'un arrêt de run silencieux, et le badge d'inbox affichait encore
   * « le scénario répond » alors que plus rien n'avançait (trou A.5). OPTIONNEL : absent -> comportement historique.
   */
  escalateToHuman?(tenantId: string, waId: string): Promise<void>;
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
  /**
   * Construit le contexte d'évaluation UNIQUEMENT si le graphe en a besoin (au moins un node `condition` ou un
   * bloc `field` en mode NOW) : évite 2 requêtes DB par étape pour les scénarios tag/template purs (l'immense
   * majorité, qui n'ont jamais de condition). Une erreur de `evalContext` (timeout pool, réseau Supabase) est
   * ABSORBÉE -> ctx undefined -> conditions 'false' (fail-closed) : un scénario qui n'utilise PAS la fonctionnalité
   * n'est jamais bloqué par une panne de sa plomberie.
   */
  private async buildCtx(tenantId: string, waId: string, graph: WorkflowGraph): Promise<EvalContext | undefined> {
    if (!this.deps.evalContext) return undefined;
    const needsCtx = graph.nodes.some((n) => n.type === 'condition'
      || (n.type === 'field' && n.data.valueKind === 'now')
      || (n.type === 'action' && n.data.actionKind === 'set_field' && n.data.valueKind === 'now'));
    if (!needsCtx) return undefined;
    try {
      return (await this.deps.evalContext(tenantId, waId)) ?? undefined;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`workflow: evalContext a échoué pour ${waId}, conditions -> 'false' (fail-closed)`, err);
      return undefined;
    }
  }

  private async apply(tenantId: string, waId: string, actions: WorkflowAction[], firstTemplateParams?: string[]): Promise<void> {
    for (const a of actions) {
      if (a.kind === 'tag') await this.deps.applyTag(tenantId, waId, a.tag);
      else if (a.kind === 'removeTag') await this.deps.removeTag(tenantId, waId, a.tag);
      else if (a.kind === 'field') await this.deps.setField(tenantId, waId, a.key, a.value);
      else if (a.kind === 'clearField') await this.deps.clearField(tenantId, waId, a.key);
      else if (a.kind === 'sendQuickMessage') await this.deps.sendQuickMessage(tenantId, waId, a.body, a.buttons);
      else if (a.kind === 'sendFlow') await this.deps.sendFlow(tenantId, waId, a.flowId, a.body, a.cta);
      else await this.deps.sendTemplate(tenantId, waId, a.templateName, a.language, a.buttons, firstTemplateParams);
    }
  }

  /**
   * Corps commun de `start` et `startFromNode` : parcourt depuis `startNodeId`, applique les actions, persiste
   * l'état (sauf 100 % synchrone -> done). `startNodeId` inconnu (bloc supprimé entre-temps) -> `walk` renvoie
   * `done` sans action : aucun envoi, aucun throw.
   *
   * ⚠️ `opts.allowSessionOpen` est la SEULE façon de lever la garde fenêtre 24 h, et il n'est posé que par
   * `startFromNode` (appelé par /v1/sends, qui a DÉJÀ vérifié la fenêtre par destinataire). Le défaut
   * (`start`, campagne classique) garde la garde : ne jamais l'inverser.
   */
  private async runFrom(
    tenantId: string,
    workflowId: string,
    graph: WorkflowGraph,
    contact: { waId: string; contactId: string | null },
    startNodeId: string,
    opts: { allowSessionOpen?: boolean; firstTemplateParams?: string[] } = {},
  ): Promise<void> {
    // Un scénario n'écrit JAMAIS dans un fil détenu par un opérateur ou par MBA. Ce garde est ici, et pas
    // seulement dans `advance`, parce que `start` et `startFromNode` passent par `runFrom` : sans lui, une
    // campagne démarrerait un parcours en plein échange humain, et les deux écriraient au client.
    if (this.deps.mayAct && !(await this.deps.mayAct(tenantId, contact.waId))) {
      // eslint-disable-next-line no-console
      console.log(`workflow ${workflowId}: fil détenu par un humain ou par MBA, run non démarré pour ${contact.waId}`);
      return;
    }
    const ctx = await this.buildCtx(tenantId, contact.waId, graph);
    const { actions, rest } = walk(graph, startNodeId, ctx);
    // Garde fenêtre 24 h : `start` est appelé par une CAMPAGNE (hors fenêtre de service), un message de
    // session (flow/quick_message) en ouverture serait rejeté par Meta (131047). Le save du graphe refuse
    // déjà cette forme (400) ; ceci est la défense runtime pour les graphes antérieurs à la garde.
    if (!opts.allowSessionOpen && actions.some((a) => a.kind === 'sendFlow' || a.kind === 'sendQuickMessage')) {
      // eslint-disable-next-line no-console
      console.error(`workflow ${workflowId}: ouverture par un message de session (flow/message rapide) hors fenêtre 24 h, run non démarré pour ${contact.waId}`);
      return;
    }
    await this.apply(tenantId, contact.waId, actions, opts.firstTemplateParams);
    const state = restToState(rest);
    if (state.status !== 'done') await this.deps.runs.start(tenantId, workflowId, contact.waId, contact.contactId, state);
    // Le run a atteint un bloc `inbox` -> la conversation passe explicitement à un humain (badge honnête, A.5).
    if (rest.status === 'inbox' && this.deps.escalateToHuman) await this.deps.escalateToHuman(tenantId, contact.waId);
  }

  /**
   * Démarre un run : parcourt depuis l'entrée, applique les actions, persiste l'état (sauf 100% synchrone -> done).
   * `firstTemplateParams` (campagne workflow) = variables du 1er template déjà résolues par contact -> passées à
   * l'envoi du 1er template SANS re-résolution via les hints stockés. Garde fenêtre 24 h APPLIQUÉE.
   */
  async start(tenantId: string, workflowId: string, graph: WorkflowGraph, contact: { waId: string; contactId: string | null }, firstTemplateParams?: string[]): Promise<void> {
    const entry = entryNode(graph);
    if (!entry) return;
    await this.runFrom(tenantId, workflowId, graph, contact, entry, firstTemplateParams ? { firstTemplateParams } : {});
  }

  /**
   * Démarre un run à un bloc ARBITRAIRE du graphe (cible `node` de /v1/sends, D-1). La garde fenêtre 24 h n'est
   * PAS appliquée ici : l'appelant a déjà écarté les contacts hors fenêtre (`out_of_window`), et l'intérêt même
   * de la cible node est d'envoyer un message de session (quick_message/flow) à quelqu'un qui vient d'écrire.
   */
  async startFromNode(tenantId: string, workflowId: string, graph: WorkflowGraph, contact: { waId: string; contactId: string | null }, startNodeId: string): Promise<void> {
    await this.runFrom(tenantId, workflowId, graph, contact, startNodeId, { allowSessionOpen: true });
  }

  /**
   * Avance le run en attente d'un contact quand il répond. No-op si aucun run / message déjà traité.
   * `buttonPayload` = bouton quick-reply tapé (`btn:<index>`) : si une arête part de ce handle on la suit
   * (branche par bouton), sinon on retombe sur la 1re arête sortante (réponse texte, ou bouton non câblé).
   */
  async advance(tenantId: string, waId: string, messageId: string, buttonPayload: string | null = null): Promise<void> {
    const run = await this.deps.runs.findWaitingByWaId(tenantId, waId);
    if (!run || run.lastMessageId === messageId) return; // dédup at-least-once
    // Le fil est-il encore à nous ? Placé APRÈS la recherche du run pour ne pas payer une requête sur les
    // messages qui n'attendent aucun parcours (le cas le plus fréquent). Le run reste `waiting` : le gel
    // est transitoire, il repart tout seul dès que le contrôle revient (fin d'échange humain, ou garde-fou
    // d'inactivité). On ne le clôt PAS, sinon un aller-retour avec un opérateur tuerait le parcours.
    if (this.deps.mayAct && !(await this.deps.mayAct(tenantId, waId))) return;
    const graph = run.currentNode ? await this.deps.getGraph(run.workflowId, tenantId) : null;
    const next = graph && run.currentNode
      ? ((buttonPayload ? nextNodeByHandle(graph, run.currentNode, buttonPayload) : null) ?? nextNode(graph, run.currentNode))
      : null;
    if (!graph || !next) {
      await this.deps.runs.setState(run.id, { currentNode: null, status: 'done', lastMessageId: messageId });
      return;
    }
    const ctx = await this.buildCtx(tenantId, waId, graph);
    const { actions, rest } = walk(graph, next, ctx);
    await this.apply(tenantId, waId, actions);
    await this.deps.runs.setState(run.id, { ...restToState(rest), lastMessageId: messageId });
    if (rest.status === 'inbox' && this.deps.escalateToHuman) await this.deps.escalateToHuman(tenantId, waId);
  }
}
