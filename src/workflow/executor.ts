import { randomUUID } from 'node:crypto';
import { walk, entryNode, nextNode, nextNodeByHandle } from './engine';
import type { WorkflowAction, WalkRest, WorkflowButton } from './engine';
import type { WorkflowGraph, WorkflowNode } from './graph';
import type { EvalContext } from './conditions';
import type { RunState, WorkflowRunRow } from './run-store.pg';
import type { RcsSender } from '../rcs/sender';
import type { RcsOutbound } from '../rcs/types';

/**
 * Résultat d'un démarrage : `true` = parti, une CHAÎNE = pas parti, avec la raison EXACTE. Le booléen seul
 * obligeait la campagne à afficher les trois causes possibles côte à côte, en laissant l'opérateur deviner
 * laquelle s'appliquait (vu en prod le 2026-08-15).
 */
export type StartOutcome = true | string;

/**
 * Ce que rend une dep d'envoi : `void` (parti) ou une CHAÎNE portant la raison d'un NON-envoi.
 *
 * Pourquoi ce canal existe : le refus décidé DANS le worker (carousel dont un visuel n'a pas pu être
 * re-téléversé, variable introuvable, template illisible) n'existait que dans les logs. La campagne, elle,
 * marquait le destinataire « envoyé » avec l'identifiant synthétique `wf-<id>` : succès à l'écran, rien sur
 * le téléphone (vécu trois fois en prod le 2026-08-15). La raison remonte maintenant jusqu'au destinataire.
 */
export type SendRefusal = void | string;

export interface WorkflowExecutorDeps {
  runs: {
    start(tenantId: string, workflowId: string, waId: string, contactId: string | null, state: RunState): Promise<{ id: string }>;
    findWaitingByWaId(tenantId: string, waId: string): Promise<WorkflowRunRow | null>;
    setState(id: string, state: RunState): Promise<void>;
  };
  getGraph(workflowId: string, tenantId: string): Promise<WorkflowGraph | null>;
  /** Pose un tag. Renvoie idéalement `true` si le tag était RÉELLEMENT nouveau : c'est cette information qui
   *  décide d'émettre « tag ajouté » (reposer un tag déjà présent n'est pas un événement). `void` accepté
   *  (câblages/fakes qui ne le disent pas) et alors traité comme nouveau, comportement historique. */
  applyTag(tenantId: string, waId: string, tag: string): Promise<void | boolean>;
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
   *
   * Rendu : `void` = parti. Une CHAÎNE = RIEN n'est parti, et elle porte la raison exacte (carousel non
   * préparable, variable manquante, template illisible chez Meta). Voir `SendRefusal`.
   */
  sendTemplate(tenantId: string, waId: string, templateName: string, language: string, buttons: WorkflowButton[], explicitParams?: string[]): Promise<SendRefusal>;
  /** Envoie un message interactif (texte + 2-3 réponses rapides) hors template. Atteint via `advance` (après
   *  réponse du contact) ou `startFromNode` (fenêtre vérifiée par l'appelant) : toujours EN fenêtre 24 h. */
  sendQuickMessage(tenantId: string, waId: string, body: string, buttons: WorkflowButton[]): Promise<SendRefusal>;
  /** Envoie un formulaire (message interactif type flow) hors template. Même contrainte de fenêtre 24 h que
   *  sendQuickMessage : la garde de `start` refuse un scénario qui OUVRE sur un flow/quick_message, et
   *  `startFromNode` n'est appelé qu'après vérification de la fenêtre destinataire par destinataire. */
  sendFlow(tenantId: string, waId: string, flowId: string, body: string, cta: string): Promise<SendRefusal>;
  /**
   * Canal RCS. ABSENT = un bloc `rcs_message` n'envoie rien et part TOUJOURS sur sa sortie « non joignable ».
   * Jamais d'envoi muet, jamais de parcours bloqué sur un canal non câblé.
   */
  rcs?: {
    sender: RcsSender;
    /** Agent RCS du tenant (`rcs_agents.agent_id`). null = tenant sans agent configuré. */
    agentIdFor(tenantId: string): Promise<string | null>;
  };
  /** Horloge (tests). Absente -> Date.now(). Sert à l'échéance d'un bloc Attente. */
  now?: () => number;
  /**
   * La fenêtre de service 24 h est-elle ouverte pour ce contact ? Utilisée à la REPRISE d'un parcours endormi :
   * la fenêtre court depuis le dernier message DU CONTACT, pas depuis notre dernière action, donc même une
   * attente courte peut la voir se fermer. Absente -> on considère la fenêtre fermée (fail-closed) : mieux
   * vaut ne pas envoyer que se faire refuser par Meta et compter l'envoi comme parti.
   */
  isWindowOpen?: (tenantId: string, waId: string) => Promise<boolean>;
  /**
   * REND la main à l'app sur un fil (inverse d'`escalateToHuman`). Appelé au lancement d'une campagne : c'est
   * un envoi VOULU par un opérateur, donc le scénario reprend la conduite du fil. Sans ça, le scénario
   * partirait et se bloquerait à la première réponse du contact.
   */
  reclaimControl?: (tenantId: string, waId: string) => Promise<void>;
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
  /**
   * L'agent de Meta est-il allumé sur le numéro de ce tenant ?
   *
   * Il décide de DEUX choses : qu'une étape sans choix cesse de bloquer le parcours (l'agent répond à la place,
   * les actions du scénario continuent), et qu'on rende le fil à Meta en fin de chaîne. ABSENT ou faux -> le
   * comportement historique est conservé au caractère près, ce qui est le cas de tous les clients aujourd'hui.
   */
  mbaActifPour?(tenantId: string): Promise<boolean>;
  /**
   * Rend le fil à l'agent de Meta (`thread_control` action `release`).
   *
   * Appelé quand le parcours se termine SANS attendre de choix du client : soit la chaîne est finie, soit le
   * contact a répondu à côté des boutons attendus. Dans les deux cas plus personne n'attend une réponse précise,
   * donc l'agent doit reprendre la parole.
   *
   * ⚠️ HYPOTHÈSE 1 du plan, invérifiable tant que MBA ne peut pas être allumé : tout envoi prend le contrôle du
   * fil, template compris. On relâche donc systématiquement. Si c'est faux pour les templates, on relâchera dans
   * le vide : une erreur journalisée, aucun dégât. Le pari inverse aurait laissé l'agent muet sur tous les
   * destinataires d'une campagne sans que personne le voie.
   *
   * ⚠️ Le message hors script qu'on vient de recevoir n'a PAS besoin d'un traitement particulier : « non lu » est
   * DÉRIVÉ en base (un entrant plus récent que la dernière ouverture du fil), donc il apparaît déjà dans l'Inbox.
   * C'était le repli prévu au plan, il existait déjà.
   *
   * ABSENT -> aucun release. Best-effort : un échec ne fait jamais échouer un parcours.
   */
  releaseToMba?(tenantId: string, waId: string): Promise<void>;
  /**
   * Publie « ce tag vient d'être posé » pour les automations. Appelée UNIQUEMENT sur un démarrage unitaire
   * (réponse d'un contact, automation, test), jamais depuis une campagne : voir la note de `apply`.
   * Absente -> aucune publication (rétro-compatible).
   */
  emitTagAdded?(tenantId: string, waId: string, tag: string): Promise<void>;
}

/** Message RCS porté par un bloc. null = bloc NON configuré : on ne devine pas un contenu, on part en repli. */
function rcsOutboundOf(node: WorkflowNode | undefined): RcsOutbound | null {
  if (!node) return null;
  const text = String(node.data.text ?? '').trim();
  return text ? { kind: 'text', text } : null;
}

/** Anti-boucle de `walkResolved` : une chaîne de blocs RCS tous non joignables finit par s'arrêter. Le walk
 *  a déjà son propre `visited` par appel, ce plafond borne l'ENCHAÎNEMENT de walks. */
const MAX_RCS_ENCHAINES = 20;

function restToState(rest: WalkRest, now: number): RunState {
  if (rest.status === 'waiting') return { currentNode: rest.nodeId, status: 'waiting' };
  // Sommeil : on garde le bloc Attente comme position courante et on pose l'échéance. Le réveil repart de SON
  // successeur (le bloc Attente lui-même a déjà « joué », le repasser rendormirait le parcours en boucle).
  if (rest.status === 'sleeping') return { currentNode: rest.nodeId, status: 'sleeping', resumeAt: new Date(now + rest.resumeInMs) };
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

  /** Horloge injectable (tests). Sert au calcul de l'échéance d'un bloc Attente. */
  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

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

  /**
   * Applique les actions d'un parcours. `emitEvents` = ce démarrage est-il UNITAIRE (un contact, ici et
   * maintenant) ? Seuls ces chemins publient les événements d'automation (« tag ajouté »).
   *
   * ⚠️ Pourquoi ce n'est PAS la dep `applyTag` qui publie : le même exécuteur sert les CAMPAGNES. Une campagne
   * workflow sur 5 000 destinataires dont le graphe contient un bloc Action poserait 5 000 événements, donc
   * potentiellement 5 000 scénarios et autant de messages facturés que personne n'a demandés. Le défaut est
   * donc `false` : on n'émet que si l'appelant prouve qu'il est unitaire.
   *
   * `firstTemplateParams` (optionnel) : variables du corps déjà résolues, transmises à l'envoi de template. Un
   * `walk` depuis un seul point d'entrée s'arrête au 1er bloc template/flow (bloquant) -> il produit AU PLUS une
   * action `sendTemplate`, donc ces params ne s'appliquent qu'à ce 1er envoi (jamais à un template ultérieur).
   */
  private async apply(
    tenantId: string,
    waId: string,
    actions: WorkflowAction[],
    firstTemplateParams?: string[],
    emitEvents = false,
  ): Promise<{ refus: string | null; partis: number }> {
    const posedTags: string[] = [];
    // Un walk peut produire PLUSIEURS envois depuis qu'un message rapide sans bouton ne bloque plus (« message,
    // message, template »). On retient donc la PREMIÈRE raison de refus, et on compte ce qui est réellement
    // parti : un refus n'est décisif pour l'appelant que si RIEN n'est parti.
    let refus: string | null = null;
    let partis = 0;
    for (const a of actions) {
      if (a.kind === 'tag') {
        const nouveau = await this.deps.applyTag(tenantId, waId, a.tag);
        // `false` = le contact portait déjà ce tag : rien n'a changé, donc rien à annoncer.
        if (nouveau !== false) posedTags.push(a.tag);
      }
      else if (a.kind === 'removeTag') await this.deps.removeTag(tenantId, waId, a.tag);
      else if (a.kind === 'field') await this.deps.setField(tenantId, waId, a.key, a.value);
      else if (a.kind === 'clearField') await this.deps.clearField(tenantId, waId, a.key);
      else {
        // ⚠️ Jamais `refus ??= await …` : `??=` n'évalue pas sa droite quand la gauche est déjà remplie, donc
        // l'envoi lui-même serait SAUTÉ. On envoie toujours, on ne garde que la 1re raison.
        const dit = a.kind === 'sendQuickMessage'
          ? await this.deps.sendQuickMessage(tenantId, waId, a.body, a.buttons)
          : a.kind === 'sendFlow'
            ? await this.deps.sendFlow(tenantId, waId, a.flowId, a.body, a.cta)
            : await this.deps.sendTemplate(tenantId, waId, a.templateName, a.language, a.buttons, firstTemplateParams);
        if (typeof dit === 'string' && dit !== '') {
          if (refus === null) refus = dit;
        } else {
          partis += 1;
        }
      }
    }
    // Publication APRÈS toutes les actions, et seulement sur un chemin unitaire. Best-effort : la pose du tag
    // est acquise, un incident de file ne doit pas faire échouer le parcours en cours.
    if (emitEvents && posedTags.length > 0 && this.deps.emitTagAdded) {
      for (const tag of posedTags) {
        try { await this.deps.emitTagAdded(tenantId, waId, tag); } catch { /* best-effort */ }
      }
    }
    return { refus, partis };
  }

  /**
   * Réveille un parcours endormi (bloc Attente arrivé à échéance) et reprend au bloc SUIVANT.
   *
   * Gardes, dans l'ordre du code :
   *  1) `mayAct` : pendant le sommeil, un opérateur ou MBA a pu reprendre le fil. On ne lui écrit pas dessus.
   *  2) le graphe et le bloc suivant existent encore (scénario ou bloc supprimé pendant le sommeil) : c'est
   *     `nextNode` qui rend null, et on clôt le run plutôt que de le laisser dormant.
   *  3) la FENÊTRE de service, seulement si la suite envoie un message de SESSION : elle court depuis le
   *     dernier message DU CONTACT, donc on la RELIT (une attente courte peut la voir fermée, une longue peut
   *     la voir rouverte si le contact a écrit entre-temps). Fermée -> on n'envoie pas et on remonte à un
   *     humain, plutôt que de compter un envoi fantôme. Un TEMPLATE part hors fenêtre, il n'est pas concerné.
   *
   * Rendu : true si le parcours a repris, false s'il a été arrêté (le run est alors clos ou remonté en inbox,
   * jamais laissé dormant, sinon il serait repris à chaque balayage).
   */
  async resume(run: { id: string; workflowId: string; tenantId: string; waId: string; contactId?: string | null; currentNode: string | null }): Promise<boolean> {
    const { tenantId, waId } = run;
    if (this.deps.mayAct && !(await this.deps.mayAct(tenantId, waId))) {
      // eslint-disable-next-line no-console
      console.log(`workflow ${run.workflowId}: fil repris par un humain ou par MBA pendant l'attente, reprise annulée pour ${waId}`);
      await this.deps.runs.setState(run.id, { currentNode: null, status: 'done' });
      return false;
    }
    const graph = await this.deps.getGraph(run.workflowId, tenantId);
    if (!graph || !run.currentNode) {
      await this.deps.runs.setState(run.id, { currentNode: null, status: 'done' });
      return false;
    }
    // On repart du SUCCESSEUR du bloc Attente : repasser sur l'attente elle-même rendormirait le parcours.
    const suite = nextNode(graph, run.currentNode);
    if (!suite) {
      await this.deps.runs.setState(run.id, { currentNode: null, status: 'done' });
      return false;
    }
    const ctx = await this.buildCtx(tenantId, waId, graph);
    const { actions, rest } = await this.walkResolved(tenantId, waId, graph, suite, ctx, run.id);

    // Fenêtre de service fermée : on écarte les SEULS messages de session (Meta les refuserait, 131047) et on
    // applique le reste. Un walk peut désormais mêler un message rapide sans bouton, des actions et un
    // TEMPLATE : jeter le lot entier ferait sauter le template, qui n'a justement pas besoin de la fenêtre.
    const aBesoinFenetre = (a: WorkflowAction): boolean => a.kind === 'sendFlow' || a.kind === 'sendQuickMessage';
    let aExecuter = actions;
    let fenetreFermee = false;
    if (actions.some(aBesoinFenetre)) {
      const ouverte = this.deps.isWindowOpen ? await this.deps.isWindowOpen(tenantId, waId) : false;
      if (!ouverte) {
        fenetreFermee = true;
        aExecuter = actions.filter((a) => !aBesoinFenetre(a));
        // eslint-disable-next-line no-console
        console.error(`workflow ${run.workflowId}: fenêtre 24 h fermée à la reprise, message de session NON envoyé à ${waId} -> conversation remontée en inbox`);
      }
    }

    // `emitEvents` VRAI : un réveil est unitaire par nature (un contact, ici et maintenant), comme `advance`.
    // Sans ça, « attendre 1 jour puis poser le tag relance » ne déclencherait pas l'automation branchée sur ce
    // tag, alors que le MÊME tag posé après une réponse la déclenche. Les campagnes, elles, n'émettent pas.
    const { refus, partis } = await this.apply(tenantId, waId, aExecuter, undefined, true);
    // Un message du parcours n'a pas pu atteindre le contact : on ne fait pas semblant de continuer, on clôt
    // et on remonte à un humain. Ce qui POUVAIT partir (template, tags) est déjà parti juste au-dessus.
    if (fenetreFermee) {
      await this.deps.runs.setState(run.id, { currentNode: null, status: 'inbox' });
      if (this.deps.escalateToHuman) await this.deps.escalateToHuman(tenantId, waId);
      return false;
    }
    // Refus au réveil sans qu'aucun message ne parte : le contact n'a rien reçu. Laisser le run en attente le
    // ferait repartir au bloc SUIVANT dès qu'il écrirait, sur un message qu'il n'a jamais vu. On clôt, et on
    // le remonte à un humain. Si un message EST parti, le parcours continue normalement.
    if (refus !== null) {
      // eslint-disable-next-line no-console
      console.error(`workflow ${run.workflowId}: envoi refusé à la reprise pour ${waId} : ${refus}`);
      if (partis === 0) {
        await this.deps.runs.setState(run.id, { currentNode: null, status: 'inbox' });
        if (this.deps.escalateToHuman) await this.deps.escalateToHuman(tenantId, waId);
        return false;
      }
    }
    await this.deps.runs.setState(run.id, restToState(rest, this.now()));
    if (rest.status === 'inbox' && this.deps.escalateToHuman) await this.deps.escalateToHuman(tenantId, waId);
    if (rest.status === 'done') await this.rendreLaMainAMba(tenantId, waId);
    return true;
  }

  /**
   * `walk` + résolution des blocs RCS. Le walk est PUR : sur un bloc `rcs_message` il rend la main avec
   * `rest.status === 'rcs_send'` parce que la branche à suivre dépend d'un appel réseau (le numéro est-il
   * joignable en RCS ?). C'est ICI, et NULLE PART ailleurs, que cette IO est faite.
   *
   * Envoi réussi -> le run attend une réponse SUR ce bloc, exactement comme après un template.
   * Non joignable, opt-out, agent absent, canal non câblé, bloc sans texte -> aucun envoi, et on repart
   * immédiatement par la sortie « non joignable ». Sortie non câblée -> parcours terminé, et surtout JAMAIS
   * la sortie « envoyé » : promettre la suite à un contact qui n'a rien reçu est le pire des deux mondes.
   *
   * Les actions des walks successifs sont ACCUMULÉES : l'appelant les applique en un lot, comme avant.
   */
  /** L'agent est-il allumé pour ce tenant ? Absent -> false, donc rien ne change. */
  private async mbaActif(tenantId: string): Promise<boolean> {
    return this.deps.mbaActifPour ? this.deps.mbaActifPour(tenantId) : false;
  }

  /**
   * Rend le fil à l'agent de Meta, sans jamais faire échouer le parcours qui l'appelle. Un release raté laisse
   * le fil à nous : l'agent reste muet sur ce fil, ce qui se voit dans l'Inbox, alors qu'une exception remontée
   * ferait échouer un envoi déjà parti.
   */
  private async rendreLaMainAMba(tenantId: string, waId: string): Promise<void> {
    if (!this.deps.releaseToMba) return;
    if (!(await this.mbaActif(tenantId))) return; // gate : aucun appel Meta si l'agent n'est pas allumé
    try {
      await this.deps.releaseToMba(tenantId, waId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`release vers MBA ignoré pour ${waId}:`, err instanceof Error ? err.message : err);
    }
  }

  private async walkResolved(
    tenantId: string,
    waId: string,
    graph: WorkflowGraph,
    startNodeId: string,
    ctx: EvalContext | undefined,
    sendKey: string,
  ): Promise<{ actions: WorkflowAction[]; rest: WalkRest }> {
    const actions: WorkflowAction[] = [];
    let depart = startNodeId;
    for (let i = 0; i < MAX_RCS_ENCHAINES; i++) {
      const r = walk(graph, depart, ctx, { mbaActif: await this.mbaActif(tenantId) });
      actions.push(...r.actions);
      if (r.rest.status !== 'rcs_send') return { actions, rest: r.rest };

      const nodeId = r.rest.nodeId;
      const msg = rcsOutboundOf(graph.nodes.find((n) => n.id === nodeId));
      const agentId = this.deps.rcs ? await this.deps.rcs.agentIdFor(tenantId) : null;
      let envoye = false;
      if (this.deps.rcs && agentId && msg) {
        const out = await this.deps.rcs.sender.sendTo(tenantId, agentId, waId, msg, `${sendKey}:${nodeId}`);
        envoye = !('skipped' in out);
      }
      if (envoye) return { actions, rest: { status: 'waiting', nodeId } };

      const repli = nextNodeByHandle(graph, nodeId, 'unreachable');
      if (!repli) return { actions, rest: { status: 'done' } };
      depart = repli;
    }
    return { actions, rest: { status: 'done' } };
  }

  /**
   * Corps commun de `start` et `startFromNode` : parcourt depuis `startNodeId`, applique les actions, persiste
   * l'état (sauf 100 % synchrone -> done). `startNodeId` inconnu (bloc supprimé entre-temps) -> `walk` renvoie
   * `done` sans action : aucun envoi, aucun throw.
   *
   * ⚠️ `opts.allowSessionOpen` est la SEULE façon de lever la garde fenêtre 24 h, et il n'est posé que par
   * `startFromNode` (appelé par /v1/sends, qui a DÉJÀ vérifié la fenêtre par destinataire). Le défaut
   * (`start`, campagne classique) garde la garde : ne jamais l'inverser.
   *
   * Renvoie la RAISON (une chaîne lisible) quand le run N'A PAS démarré : bloc de départ absent du graphe (bloc supprimé entre-temps),
   * fil détenu par un humain/MBA, ou ouverture par un message de session hors fenêtre. Sans ce signal, l'appelant
   * campagne comptait le destinataire en `sent` alors que rien n'était parti (campagne « 500 envoyés, 0 échec »
   * pour 0 message réel). `true` = le parcours a bien été appliqué.
   */
  private async runFrom(
    tenantId: string,
    workflowId: string,
    graph: WorkflowGraph,
    contact: { waId: string; contactId: string | null },
    startNodeId: string,
    opts: { allowSessionOpen?: boolean; firstTemplateParams?: string[]; emitEvents?: boolean; ignoreHumanControl?: boolean } = {},
  ): Promise<StartOutcome> {
    // Un scénario n'écrit JAMAIS dans un fil détenu par un opérateur ou par MBA. Ce garde est ici, et pas
    // seulement dans `advance`, parce que `start` et `startFromNode` passent par `runFrom` : sans lui, une
    // campagne démarrerait un parcours en plein échange humain, et les deux écriraient au client.
    // « Avoir la main » empêche le scénario de CONTINUER tout seul et MBA de répondre. Ça n'empêche PAS un
    // opérateur d'envoyer une campagne : c'est LUI qui la déclenche, donc c'est lui qui a la main. Le lancement
    // depuis une campagne passe donc `ignoreHumanControl` et REPREND la main pour l'app, sans quoi le scénario
    // partirait puis se bloquerait à la première réponse.
    if (opts.ignoreHumanControl) {
      if (this.deps.reclaimControl) await this.deps.reclaimControl(tenantId, contact.waId);
    } else if (this.deps.mayAct && !(await this.deps.mayAct(tenantId, contact.waId))) {
      // eslint-disable-next-line no-console
      console.log(`workflow ${workflowId}: fil détenu par un humain ou par MBA, run non démarré pour ${contact.waId}`);
      return "la conversation est tenue par un opérateur (ou par MBA) : ce déclenchement automatique n'écrit pas dedans. Rends la main depuis l'Inbox pour la rouvrir.";
    }
    // Bloc de départ absent du graphe (supprimé entre la création de l'envoi et son exécution) : `walk` renverrait
    // un `done` vide, indiscernable d'un parcours réussi sans action. On le signale explicitement, sinon la
    // campagne compterait « envoyé » un destinataire pour qui rien n'est parti.
    if (!graph.nodes.some((n) => n.id === startNodeId)) {
      // eslint-disable-next-line no-console
      console.error(`workflow ${workflowId}: bloc de départ ${startNodeId} introuvable, run non démarré pour ${contact.waId}`);
      return 'le bloc de départ du scénario a été supprimé depuis la création de la campagne';
    }
    const ctx = await this.buildCtx(tenantId, contact.waId, graph);
    // `sendKey` aléatoire : à ce stade le run n'existe pas encore en base (runs.start vient plus bas), donc
    // aucun identifiant stable n'est disponible. Ce qui protège d'un double envoi ici, c'est le claim atomique
    // du destinataire côté campagne, pas l'idempotence RBM.
    const { actions, rest } = await this.walkResolved(tenantId, contact.waId, graph, startNodeId, ctx, randomUUID());
    // Garde fenêtre 24 h : `start` est appelé par une CAMPAGNE (hors fenêtre de service), un message de
    // session (flow/quick_message) en ouverture serait rejeté par Meta (131047). Depuis le Lot D, le SAVE
    // n'interdit plus cette forme (un scénario peut ouvrir sur un message de session, il est alors réservé aux
    // déclenchements en fenêtre garantie) : c'est `POST /campaigns` qui refuse un tel scénario en campagne, et
    // CETTE garde est le filet runtime si un autre chemin tentait quand même un `start` classique.
    if (!opts.allowSessionOpen && actions.some((a) => a.kind === 'sendFlow' || a.kind === 'sendQuickMessage')) {
      // eslint-disable-next-line no-console
      console.error(`workflow ${workflowId}: ouverture par un message de session (flow/message rapide) hors fenêtre 24 h, run non démarré pour ${contact.waId}`);
      return "le scénario ouvre par un message rapide ou un formulaire, impossible hors de la fenêtre de 24 h";
    }
    const { refus, partis } = await this.apply(tenantId, contact.waId, actions, opts.firstTemplateParams, opts.emitEvents === true);
    // Refus alors que RIEN n'est parti : le contact n'a rien reçu. On ne persiste PAS de run en attente, pour
    // deux raisons. D'abord il attendrait une réponse à un message jamais reçu. Ensuite il serait ressuscité
    // par n'importe quel message ultérieur du contact, qui recevrait alors le bloc SUIVANT, sorti de nulle
    // part. On remonte la raison telle quelle : c'est elle que la campagne affiche sur le destinataire.
    // Si un message EST parti, le destinataire a bien été touché : le parcours vit, et le refus reste au log.
    if (refus !== null) {
      // eslint-disable-next-line no-console
      console.error(`workflow ${workflowId}: envoi refusé pour ${contact.waId} : ${refus}`);
      if (partis === 0) return refus;
    }
    const state = restToState(rest, this.now());
    if (state.status !== 'done') await this.deps.runs.start(tenantId, workflowId, contact.waId, contact.contactId, state);
    // Le run a atteint un bloc `inbox` -> la conversation passe explicitement à un humain (badge honnête, A.5).
    if (rest.status === 'inbox' && this.deps.escalateToHuman) await this.deps.escalateToHuman(tenantId, contact.waId);
    if (rest.status === 'done') await this.rendreLaMainAMba(tenantId, contact.waId);
    return true;
  }

  /**
   * Démarre un run : parcourt depuis l'entrée, applique les actions, persiste l'état (sauf 100% synchrone -> done).
   * `firstTemplateParams` (campagne workflow) = variables du 1er template déjà résolues par contact -> passées à
   * l'envoi du 1er template SANS re-résolution via les hints stockés. Garde fenêtre 24 h APPLIQUÉE.
   *
   * Renvoie la RAISON du refus (une chaîne) si le run n'a PAS démarré (cf. `runFrom`), y compris sur un graphe VIDE : l'appelant
   * campagne doit pouvoir marquer le destinataire en échec plutôt que de le compter comme envoyé.
   */
  async start(
    tenantId: string, workflowId: string, graph: WorkflowGraph,
    contact: { waId: string; contactId: string | null },
    firstTemplateParams?: string[],
    opts: { emitEvents?: boolean; ignoreHumanControl?: boolean } = {},
  ): Promise<StartOutcome> {
    const entry = entryNode(graph);
    if (!entry) return 'le scénario est vide';
    return this.runFrom(tenantId, workflowId, graph, contact, entry, { ...(firstTemplateParams ? { firstTemplateParams } : {}), ...opts });
  }

  /**
   * Démarre un run depuis l'ENTRÉE, pour un contact dont la fenêtre de service 24 h est GARANTIE OUVERTE parce
   * qu'il vient d'écrire (automation déclenchée par un message entrant). La garde fenêtre n'a alors pas lieu
   * d'être : le scénario peut légitimement ouvrir par un message rapide ou un formulaire, ce qui est justement
   * l'usage que le Lot D a rendu possible.
   *
   * ⚠️ À n'appeler QUE sur un chemin où la fenêtre est prouvée par un inbound récent. Un déclencheur qui ne
   * prouve pas la fenêtre (ex. un tag posé depuis le CRM) doit passer par `start()`, qui garde la protection.
   *
   * `ignoreHumanControl` sert au lancement DEPUIS L'INBOX : l'opérateur y détient presque toujours le fil (il
   * l'a pris en répondant), et c'est pourtant LUI qui demande le scénario. Le refuser au motif qu'il a la main
   * serait absurde. Même règle que le lancement d'une campagne : « avoir la main » empêche le scénario
   * d'avancer tout seul et MBA de répondre, jamais un opérateur d'envoyer.
   */
  async startInWindow(
    tenantId: string, workflowId: string, graph: WorkflowGraph,
    contact: { waId: string; contactId: string | null },
    opts: { emitEvents?: boolean; ignoreHumanControl?: boolean } = {},
  ): Promise<StartOutcome> {
    const entry = entryNode(graph);
    if (!entry) return 'le scénario est vide';
    return this.runFrom(tenantId, workflowId, graph, contact, entry, { allowSessionOpen: true, ...opts });
  }

  /**
   * Démarre un run à un bloc ARBITRAIRE du graphe (cible `node` de /v1/sends, D-1). La garde fenêtre 24 h n'est
   * PAS appliquée ici : l'appelant a déjà écarté les contacts hors fenêtre (`out_of_window`), et l'intérêt même
   * de la cible node est d'envoyer un message de session (quick_message/flow) à quelqu'un qui vient d'écrire.
   */
  async startFromNode(
    tenantId: string, workflowId: string, graph: WorkflowGraph,
    contact: { waId: string; contactId: string | null }, startNodeId: string,
    opts: { emitEvents?: boolean; ignoreHumanControl?: boolean } = {},
  ): Promise<StartOutcome> {
    return this.runFrom(tenantId, workflowId, graph, contact, startNodeId, { allowSessionOpen: true, ...opts });
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
    // Bloc RCS en attente : la réponse du contact reprend par la sortie « envoyé », pas par un payload de
    // bouton. Et le repli conditionnel suit la règle du bloc Condition : tant qu'une sortie TYPÉE existe, on
    // ne prend JAMAIS la 1re arête venue, sinon « non joignable » volerait la suite d'un envoi réussi.
    const courant = graph && run.currentNode ? graph.nodes.find((n) => n.id === run.currentNode) : undefined;
    const handle = courant?.type === 'rcs_message' ? 'sent' : buttonPayload;
    const sortieTypee = graph && run.currentNode
      ? graph.edges.some((e) => e.source === run.currentNode && (e.sourceHandle === 'sent' || e.sourceHandle === 'unreachable'))
      : false;
    const next = graph && run.currentNode
      ? ((handle ? nextNodeByHandle(graph, run.currentNode, handle) : null) ?? (sortieTypee ? null : nextNode(graph, run.currentNode)))
      : null;
    if (!graph || !next) {
      // Le contact a répondu À CÔTÉ des boutons attendus (aucune arête ne correspond), ou le scénario n'a plus
      // de suite. Plus personne n'attend une réponse précise : l'agent de Meta reprend la parole. Le message
      // reste visible dans l'Inbox, « non lu » étant dérivé d'un entrant plus récent que la dernière ouverture.
      await this.deps.runs.setState(run.id, { currentNode: null, status: 'done', lastMessageId: messageId });
      await this.rendreLaMainAMba(tenantId, waId);
      return;
    }
    const ctx = await this.buildCtx(tenantId, waId, graph);
    const { actions, rest } = await this.walkResolved(tenantId, waId, graph, next, ctx, run.id);
    // Un contact qui répond est unitaire par nature : ses tags publient.
    const { refus, partis } = await this.apply(tenantId, waId, actions, undefined, true);
    // Même règle qu'au réveil : un envoi refusé n'attend aucune réponse. On clôt le run (en gardant
    // `lastMessageId`, sinon le même message serait re-traité) et on remonte la conversation à un humain.
    if (refus !== null) {
      // eslint-disable-next-line no-console
      console.error(`workflow ${run.workflowId}: envoi refusé pour ${waId} : ${refus}`);
      if (partis === 0) {
        await this.deps.runs.setState(run.id, { currentNode: null, status: 'inbox', lastMessageId: messageId });
        if (this.deps.escalateToHuman) await this.deps.escalateToHuman(tenantId, waId);
        return;
      }
    }
    await this.deps.runs.setState(run.id, { ...restToState(rest, this.now()), lastMessageId: messageId });
    if (rest.status === 'inbox' && this.deps.escalateToHuman) await this.deps.escalateToHuman(tenantId, waId);
    // Chaîne terminée sans attendre de choix : l'agent reprend. `waiting` garde la main (le scénario attend un
    // bouton), `inbox` la donne à un humain : ni l'un ni l'autre ne relâche.
    if (rest.status === 'done') await this.rendreLaMainAMba(tenantId, waId);
  }
}
