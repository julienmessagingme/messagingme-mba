import { jamaisDesabonne } from './consentement';
import { describe, it, expect, vi } from 'vitest';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';
import type { EvalContext } from '../src/workflow/conditions';
import type { WorkflowRunRow, RunState } from '../src/workflow/run-store.pg';
import type { AgentTurnJob } from '../src/agent/turn-job';

const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const e = (id: string, source: string, target: string) => ({ id, source, target });
const eh = (id: string, source: string, target: string, sourceHandle: string) => ({ id, source, target, sourceHandle });

class FakeRuns {
  /** Les appels a la fermeture du parcours precedent, pour prouver QUAND elle a lieu et quand elle n a pas lieu. */
  fermetures: string[] = [];
  /** Requis par le contrat : un demarrage remplace le parcours en cours. Rend le nombre de lignes closes. */
  async closeActiveByWaId(_tenantId: string, waId: string): Promise<string[]> {
    this.fermetures.push(waId);
    return ['run-precedent'];
  }

  run: WorkflowRunRow | null = null;
  /** L'état COMPLET reçu au démarrage. `WorkflowRunRow` ne porte pas `resumeAt`, or c'est justement lui qui dit
   *  QUAND un parcours endormi doit repartir : sans ça, un test ne peut vérifier que le statut. */
  dernierEtat: RunState | null = null;
  async start(tenantId: string, workflowId: string, waId: string, _contactId: string | null, state: RunState): Promise<{ id: string }> {
    this.dernierEtat = state;
    this.run = { id: 'r1', workflowId, tenantId, waId, currentNode: state.currentNode, status: state.status, lastMessageId: null };
    return { id: 'r1' };
  }
  async findWaitingByWaId(_t: string, waId: string): Promise<WorkflowRunRow | null> {
    return this.run && this.run.status === 'waiting' && this.run.waId === waId ? this.run : null;
  }
  async setState(id: string, state: RunState): Promise<void> {
    if (this.run && this.run.id === id) this.run = { ...this.run, currentNode: state.currentNode, status: state.status, lastMessageId: state.lastMessageId ?? this.run.lastMessageId };
  }
}

function make(graph: WorkflowGraph, over: Partial<WorkflowExecutorDeps> = {}) {
  const runs = new FakeRuns();
  const calls: string[] = [];
  const escalations: string[] = []; // capture séparée : les assertions `calls` existantes restent inchangées
  const ex = new WorkflowExecutor({
    estDesabonne: jamaisDesabonne,
    runs,
    getGraph: async () => graph,
    applyTag: async (_t, _w, tag) => { calls.push(`tag:${tag}`); },
    setField: async (_t, _w, k, v) => { calls.push(`field:${k}=${v}`); },
    removeTag: async (_t, _w, tag) => { calls.push(`untag:${tag}`); },
    clearField: async (_t, _w, k) => { calls.push(`clear:${k}`); },
    sendTemplate: async (_t, _w, name) => { calls.push(`tpl:${name}`); },
    sendQuickMessage: async (_t, _w, body) => { calls.push(`qm:${body}`); },
    sendFlow: async (_t, _w, flowId, body, cta) => { calls.push(`flow:${flowId}:${body}:${cta}`); },
    sendQuestion: async (_t, _w, body, bouton, rows) => { calls.push(`question:${body}:${bouton}:${rows.map((r) => r.title).join('|')}`); },
    escalateToHuman: async (_t, w) => { escalations.push(w); },
    ...over,
  });
  return { ex, runs, calls, escalations };
}

describe('WorkflowExecutor', () => {
  // tag -> template -> inbox
  const linear: WorkflowGraph = {
    nodes: [n('t', 'tag', { tag: 'vip' }), n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('ib', 'inbox')],
    edges: [e('e1', 't', 'tpl'), e('e2', 'tpl', 'ib')],
  };

  describe('lancer un scenario REMPLACE celui en cours (regle Julien, 2026-09-07)', () => {
    it('🔴 A1 : un demarrage clot le parcours actif du contact', async () => {
      // « On ne bloque personne sur un scenario, surtout quand on lance un nouveau scenario. » La fermeture
      // est posee sur le passage COMMUN (`runFrom`), donc les quatre chemins de demarrage en heritent :
      // inbox, jeton de test, automation (le lien de chaine) et campagne.
      const { ex, runs } = make(linear);
      await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' });
      expect(runs.fermetures).toEqual(['33600']);
    });

    it('🔴 A1bis : un demarrage AU BLOC (cible node de /v1/sends) ferme aussi', async () => {
      const { ex, runs } = make(linear);
      await ex.startFromNode('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' }, 'tpl');
      expect(runs.fermetures).toEqual(['33600']);
    });

    it('🔴 A3 : le chemin Inbox / automation (startInWindow) ferme aussi', async () => {
      // Ce chemin fermait DEJA, mais chez son appelant (`src/index.ts`), pas dans l executeur. La copie a ete
      // retiree ; sans ce test, plus rien ne garderait le comportement pour l operateur.
      const { ex, runs } = make(linear);
      await ex.startInWindow('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' });
      expect(runs.fermetures).toEqual(['33600']);
    });

    it('🔴 la session d agent du parcours ferme SUIT le parcours', async () => {
      // Tuer le run sans clore sa session la laisse `en_cours` avec un tour jamais commence : invisible de la
      // reprise des tours bloques, jusqu a la purge de retention. Rare quand la fermeture etait un geste
      // d operateur, ordinaire depuis qu elle a lieu par destinataire de campagne.
      const closes: Array<{ id: string; statut: string }> = [];
      const { ex } = make(linear, {
        agentSessions: {
          byRun: async () => ({ id: 'sess-1' }),
          clore: async (_t: string, id: string, statut: string) => { closes.push({ id, statut }); },
        } as unknown as WorkflowExecutorDeps['agentSessions'],
      });
      await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' });
      expect(closes).toEqual([{ id: 'sess-1', statut: 'erreur' }]);
    });

    it('🔴 LE CAS QUI DECIDE DE L EMPLACEMENT : un demarrage REFUSE ne ferme RIEN', async () => {
      // Trois gardes peuvent refuser AVANT tout envoi (fil tenu par un humain ou MBA, bloc de depart
      // supprime, ouverture hors fenetre 24 h). Fermer a l entree de `runFrom` aurait tue le parcours en
      // cours d un contact pour un demarrage qui n a jamais eu lieu, EN SILENCE : le contact se serait
      // retrouve sans rien, et personne n aurait su pourquoi. On ne remplace que ce qu on a remplace.
      const { ex, runs, calls } = make(linear, { mayAct: async () => false });
      const issue = await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' });
      expect(typeof issue).toBe('string');
      expect(calls).toEqual([]);
      expect(runs.fermetures).toEqual([]);
    });

    it('🔴 un bloc de depart disparu ne ferme rien non plus', async () => {
      const { ex, runs } = make(linear);
      const issue = await ex.startFromNode('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' }, 'bloc-supprime');
      expect(typeof issue).toBe('string');
      expect(runs.fermetures).toEqual([]);
    });
  });

  it('start : pose le tag, envoie le template, run en attente au template', async () => {
    const { ex, runs, calls } = make(linear);
    await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tag:vip', 'tpl:promo']);
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'tpl' });
  });

  it('start : bloc action « retirer tag » puis « vider champ » appelle removeTag / clearField', async () => {
    const g: WorkflowGraph = {
      nodes: [n('a1', 'action', { actionKind: 'remove_tag', tag: 'vip' }), n('a2', 'action', { actionKind: 'clear_field', fieldKey: 'statut' }), n('ib', 'inbox')],
      edges: [e('e1', 'a1', 'a2'), e('e2', 'a2', 'ib')],
    };
    const { ex, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['untag:vip', 'clear:statut']);
  });

  it('advance : le contact répond -> la conversation arrive en inbox (run terminé)', async () => {
    const { ex, runs, calls } = make(linear);
    await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' });
    await ex.advance('t1', '33600', 'msg1');
    expect(runs.run).toMatchObject({ status: 'inbox', currentNode: null });
    expect(calls).toEqual(['tag:vip', 'tpl:promo']); // pas de nouvel envoi (inbox n'a pas d'action)
  });

  it('atteindre le node inbox escalade à un humain (escalateToHuman) ; pas d’escalade tant qu’on n’y est pas', async () => {
    const { ex, escalations } = make(linear);
    await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' });
    expect(escalations).toEqual([]); // start s'arrête au template (waiting), pas encore inbox
    await ex.advance('t1', '33600', 'msg1'); // le contact répond -> node inbox
    expect(escalations).toEqual(['33600']);
  });

  // Garde fenêtre 24 h (Lot 7) : `start` = chemin campagne, HORS fenêtre de service -> un scénario qui OUVRE
  // sur un message de session (quick_message/flow) est refusé en bloc (aucune action, aucun run).
  it('start : quick_message en OUVERTURE -> refusé (fenêtre 24 h), aucune action, aucun run', async () => {
    const g: WorkflowGraph = { nodes: [n('qm', 'quick_message', { body: 'Salut', quickReplies: ['Oui', 'Non'] })], edges: [] };
    const { ex, runs, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual([]);
    expect(runs.run).toBeNull();
  });

  it('start : tag -> flow en ouverture -> refusé EN BLOC (le tag non plus n\'est pas appliqué)', async () => {
    const g: WorkflowGraph = {
      nodes: [n('t', 'tag', { tag: 'vip' }), n('f', 'flow', { flowId: 'fl1', flowName: 'RDV' })],
      edges: [e('e1', 't', 'f')],
    };
    const { ex, runs, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual([]);
    expect(runs.run).toBeNull();
  });

  it('advance : quick_message APRÈS un template est envoyé (fenêtre ouverte), run en attente au bloc', async () => {
    const g: WorkflowGraph = {
      nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('qm', 'quick_message', { body: 'Salut', quickReplies: ['Oui', 'Non'] })],
      edges: [e('e1', 'tpl', 'qm')],
    };
    const { ex, runs, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tpl:promo']);
    await ex.advance('t1', '33600', 'm1');
    expect(calls).toEqual(['tpl:promo', 'qm:Salut']);
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'qm' });
  });

  it('advance : node flow APRÈS un template -> sendFlow (flowId + accroche par défaut + cta), attente au bloc', async () => {
    const g: WorkflowGraph = {
      nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('f', 'flow', { flowId: 'fl1', flowName: 'RDV' })],
      edges: [e('e1', 'tpl', 'f')],
    };
    const { ex, runs, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    await ex.advance('t1', '33600', 'm1');
    expect(calls).toEqual(['tpl:promo', 'flow:fl1:Formulaire : RDV:Envoyer']);
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'f' });
  });

  it('advance : node flow SANS flowId -> aucune action (no-op), run en attente (même contrat que template vide)', async () => {
    const g: WorkflowGraph = {
      nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('f', 'flow', {})],
      edges: [e('e1', 'tpl', 'f')],
    };
    const { ex, runs, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    await ex.advance('t1', '33600', 'm1');
    expect(calls).toEqual(['tpl:promo']);
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'f' });
  });

  it('workflow 100% synchrone (tag seul) : action appliquée, AUCUN run persistant', async () => {
    const g: WorkflowGraph = { nodes: [n('t', 'tag', { tag: 'x' })], edges: [] };
    const { ex, runs, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tag:x']);
    expect(runs.run).toBeNull();
  });

  it('advance idempotent : un même message ne fait pas avancer 2 fois', async () => {
    // tag -> tpl1 -> tpl2 -> inbox : après la 1re réponse, run attend au tpl2.
    const g: WorkflowGraph = {
      nodes: [n('t', 'tag', { tag: 'a' }), n('tpl1', 'template', { templateName: 't1', language: 'fr' }), n('tpl2', 'template', { templateName: 't2', language: 'fr' }), n('ib', 'inbox')],
      edges: [e('e1', 't', 'tpl1'), e('e2', 'tpl1', 'tpl2'), e('e3', 'tpl2', 'ib')],
    };
    const { ex, runs, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tag:a', 'tpl:t1']);
    await ex.advance('t1', '33600', 'm1'); // -> envoie t2, attend au tpl2
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'tpl2', lastMessageId: 'm1' });
    await ex.advance('t1', '33600', 'm1'); // MÊME message -> no-op
    expect(calls).toEqual(['tag:a', 'tpl:t1', 'tpl:t2']); // pas de 2e envoi de t2
  });

  it('advance sans run en attente -> no-op', async () => {
    const { ex } = make(linear);
    await expect(ex.advance('t1', '33600', 'm1')).resolves.toBeUndefined();
  });

  // template à 2 boutons quick-reply -> 2 branches (btn:0 -> tag oui, btn:1 -> tag non).
  const branched: WorkflowGraph = {
    nodes: [
      n('tpl', 'template', { templateName: 'promo', language: 'fr', templateButtons: [{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'QUICK_REPLY', text: 'Non' }] }),
      n('ta', 'tag', { tag: 'oui' }), n('tb', 'tag', { tag: 'non' }), n('ib', 'inbox'),
    ],
    edges: [eh('e0', 'tpl', 'ta', 'btn:0'), eh('e1', 'tpl', 'tb', 'btn:1'), e('e2', 'ta', 'ib'), e('e3', 'tb', 'ib')],
  };

  it('advance BRANCHE par bouton : btn:1 -> suit l\'arête de CE bouton', async () => {
    const { ex, runs, calls } = make(branched);
    await ex.start('t1', 'wf1', branched, { waId: '33600', contactId: 'c1' });
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'tpl' });
    await ex.advance('t1', '33600', 'm1', 'btn:1'); // tape « Non »
    expect(calls).toContain('tag:non');
    expect(calls).not.toContain('tag:oui');
    expect(runs.run).toMatchObject({ status: 'inbox' });
  });

  // Toutes les arêtes de `branched` partent d'un bouton : le scénario n'a rien prévu pour une réponse hors
  // boutons. Règle produit du 2026-08-20 : on ne l'envoie PAS dans la branche du 1er bouton (« non merci » se
  // faisait taguer « oui »), on clôt le run et l'agent reprend la parole.
  it('advance HORS boutons : réponse texte (buttonPayload null) -> aucune branche, run clos', async () => {
    const releases: string[] = [];
    const { ex, runs, calls } = make(branched, {
      mbaActifPour: async () => true,
      releaseToMba: async (_t, w) => { releases.push(w); },
    });
    await ex.start('t1', 'wf1', branched, { waId: '33600', contactId: 'c1' });
    await ex.advance('t1', '33600', 'm2', null);
    expect(calls).not.toContain('tag:oui');
    expect(calls).not.toContain('tag:non');
    expect(runs.run).toMatchObject({ status: 'done', currentNode: null });
    expect(releases).toEqual(['33600']); // l'agent reprend la parole
  });

  it('🔴 advance HORS boutons : un bouton TAPÉ qui ne mène nulle part remonte à un humain', async () => {
    // Ce n'est pas le contact qui sort du script : on lui a proposé un choix, il l'a fait, et il n'a rien reçu.
    // C'est un TROU DE MONTAGE du scénario. Vécu par Julien le 2026-08-25 : bouton tapé, parcours terminé
    // sur-le-champ, aucune trace, aucun signal. Le run se clot toujours, mais la conversation part en
    // « À traiter » au lieu d'être rendue à l'agent : quelqu'un doit voir que ce bouton ne mène nulle part.
    const releases: string[] = [];
    const { ex, runs, calls, escalations } = make(branched, {
      mbaActifPour: async () => true,
      releaseToMba: async (_t, w) => { releases.push(w); },
    });
    await ex.start('t1', 'wf1', branched, { waId: '33600', contactId: 'c1' });
    await ex.advance('t1', '33600', 'm3', 'btn:9');
    expect(calls).not.toContain('tag:oui');
    expect(calls).not.toContain('tag:non');
    expect(runs.run).toMatchObject({ status: 'done', currentNode: null });
    expect(escalations).toEqual(['33600']);
    // ... et l'agent NE reprend PAS la parole sur ce cas : sinon le défaut de montage resterait invisible.
    expect(releases).toEqual([]);
  });

  it('advance HORS boutons : une réponse ÉCRITE n escalade PAS (c est le cas nominal, l agent reprend)', async () => {
    // La distinction est tout l'intérêt du correctif : écrire au lieu de cliquer n'est pas un défaut du
    // scénario. Escalader là aussi noierait le signal sous des conversations parfaitement normales.
    const { ex, escalations } = make(branched);
    await ex.start('t1', 'wf1', branched, { waId: '33600', contactId: 'c1' });
    await ex.advance('t1', '33600', 'm3', null);
    expect(escalations).toEqual([]);
    // Et un payload qui n est PAS un handle reliable (vieux template dont le payload porte le libelle du
    // bouton) suit le meme chemin : on n escalade que sur ce que l editeur sait relier.
    await ex.advance('t1', '33600', 'm4', 'Autre chose');
    expect(escalations).toEqual([]);
  });

  // Même bloc à boutons, plus une arête LIBRE tirée depuis le corps du bloc : c'est la sortie « toute autre
  // réponse ». Elle existe -> le scénario A prévu le cas, et on la suit.
  const branchedAvecSortieLibre: WorkflowGraph = {
    nodes: [...branched.nodes, n('tc', 'tag', { tag: 'autre' })],
    edges: [...branched.edges, e('e4', 'tpl', 'tc')],
  };

  it('advance HORS boutons : une arête LIBRE existe -> on la suit', async () => {
    const { ex, calls } = make(branchedAvecSortieLibre);
    await ex.start('t1', 'wf1', branchedAvecSortieLibre, { waId: '33600', contactId: 'c1' });
    await ex.advance('t1', '33600', 'm4', null);
    expect(calls).toContain('tag:autre');
    expect(calls).not.toContain('tag:oui');
  });

  it('advance BRANCHE par bouton : le bouton câblé passe AVANT l\'arête libre', async () => {
    const { ex, calls } = make(branchedAvecSortieLibre);
    await ex.start('t1', 'wf1', branchedAvecSortieLibre, { waId: '33600', contactId: 'c1' });
    await ex.advance('t1', '33600', 'm5', 'btn:1');
    expect(calls).toContain('tag:non');
    expect(calls).not.toContain('tag:autre');
  });

  // Capture le 6e arg (explicitParams) de sendTemplate pour vérifier le câblage campagne workflow.
  function makeCapturing(graph: WorkflowGraph) {
    const runs = new FakeRuns();
    const captured: Array<string[] | undefined> = [];
    const ex = new WorkflowExecutor({
      estDesabonne: jamaisDesabonne,
      runs,
      getGraph: async () => graph,
      applyTag: async () => {},
      setField: async () => {},
      removeTag: async () => {},
      clearField: async () => {},
      sendTemplate: async (_t, _w, _name, _lang, _btns, explicitParams) => { captured.push(explicitParams); },
      sendQuickMessage: async () => {},
      sendFlow: async () => {},
      sendQuestion: async () => {},
    });
    return { ex, captured };
  }

  it('start avec firstTemplateParams : le 1er sendTemplate reçoit ces params (campagne workflow, pas de re-résolution)', async () => {
    const g: WorkflowGraph = {
      nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('ib', 'inbox')],
      edges: [e('e1', 'tpl', 'ib')],
    };
    const { ex, captured } = makeCapturing(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' }, ['Julie']);
    expect(captured).toEqual([['Julie']]);
  });

  // startFromNode (cible node de /v1/sends, D-1) : démarre à un bloc ARBITRAIRE, SANS la garde fenêtre 24 h
  // (l'appelant a déjà écarté les contacts hors fenêtre). `start` garde la sienne : cf. tests plus haut.
  describe('startFromNode', () => {
    it('démarre à un bloc du MILIEU du graphe (les blocs amont ne sont pas rejoués)', async () => {
      const g: WorkflowGraph = {
        nodes: [n('t', 'tag', { tag: 'amont' }), n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('ib', 'inbox')],
        edges: [e('e1', 't', 'tpl'), e('e2', 'tpl', 'ib')],
      };
      const { ex, runs, calls } = make(g);
      await ex.startFromNode('t1', 'wf1', g, { waId: '33600', contactId: 'c1' }, 'tpl');
      expect(calls).toEqual(['tpl:promo']); // pas de 'tag:amont' : on a sauté l'entrée
      expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'tpl' });
    });

    it('quick_message en cible : PART (contrairement à start qui le bloquerait)', async () => {
      const g: WorkflowGraph = { nodes: [n('qm', 'quick_message', { body: 'Salut', quickReplies: ['Oui', 'Non'] })], edges: [] };
      const { ex, runs, calls } = make(g);
      await ex.startFromNode('t1', 'wf1', g, { waId: '33600', contactId: 'c1' }, 'qm');
      expect(calls).toEqual(['qm:Salut']);
      expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'qm' });
      // NON-RÉGRESSION : le MÊME graphe via `start` reste refusé (garde 24 h intacte).
      const via = make(g);
      await via.ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
      expect(via.calls).toEqual([]);
      expect(via.runs.run).toBeNull();
    });

    it('flow en cible : PART aussi (message de session légitime en fenêtre ouverte)', async () => {
      const g: WorkflowGraph = { nodes: [n('f', 'flow', { flowId: 'fl1', flowName: 'RDV' })], edges: [] };
      const { ex, calls } = make(g);
      await ex.startFromNode('t1', 'wf1', g, { waId: '33600', contactId: 'c1' }, 'f');
      expect(calls).toEqual(['flow:fl1:Formulaire : RDV:Envoyer']);
    });

    it('bloc SUPPRIMÉ entre-temps (nodeId inconnu) -> aucune action, aucun run, aucun throw, et le NON-démarrage est signalé', async () => {
      const { ex, runs, calls } = make(linear);
      // Pas `true` = rien n'est parti : c'est ce que la campagne doit voir pour marquer le destinataire en échec
      // au lieu de le compter comme envoyé (revue Lot D). Depuis le 2026-08-15 le refus porte SA RAISON (une
      // chaîne) au lieu d'un simple `false`, pour que la campagne l'affiche telle quelle.
      const refus = await ex.startFromNode('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' }, 'disparu');
      expect(refus).not.toBe(true);
      expect(typeof refus).toBe('string');
      expect(calls).toEqual([]);
      expect(runs.run).toBeNull();
    });

    it('cible 100 % synchrone (tag en fin de chaîne) : action appliquée, aucun run persistant', async () => {
      const g: WorkflowGraph = { nodes: [n('t', 'tag', { tag: 'x' })], edges: [] };
      const { ex, runs, calls } = make(g);
      await ex.startFromNode('t1', 'wf1', g, { waId: '33600', contactId: 'c1' }, 't');
      expect(calls).toEqual(['tag:x']);
      expect(runs.run).toBeNull();
    });
  });

  it('advance : sendTemplate SANS explicitParams (hints stockés -> comportement inchangé)', async () => {
    // tpl1 -> tpl2 -> inbox : start envoie tpl1 AVEC params, l\'advance envoie tpl2 SANS params (undefined).
    const g: WorkflowGraph = {
      nodes: [n('tpl1', 'template', { templateName: 't1', language: 'fr' }), n('tpl2', 'template', { templateName: 't2', language: 'fr' }), n('ib', 'inbox')],
      edges: [e('e1', 'tpl1', 'tpl2'), e('e2', 'tpl2', 'ib')],
    };
    const { ex, captured } = makeCapturing(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' }, ['Julie']);
    await ex.advance('t1', '33600', 'm1');
    expect(captured).toEqual([['Julie'], undefined]);
  });
});

describe('WorkflowExecutor : blocs condition & field NOW (contexte injecté par evalContext)', () => {
  /**
   * `now` fait coïncider les DEUX horloges d'une même étape : celle du contexte (`ctx.now`, qui sert au calcul
   * de l'échéance) et celle de l'exécuteur (`deps.now`, qui la transforme en `resume_at`). En production elles
   * sont distantes de quelques millisecondes ; dans un test à date figée, sans ce paramètre, l'échéance serait
   * calculée depuis 2026 et posée depuis aujourd'hui.
   */
  function makeEval(graph: WorkflowGraph, ctx: EvalContext | null, surBesoins?: (b?: { derniereSaisie: boolean }) => void, now?: () => number) {
    const runs = new FakeRuns();
    const calls: string[] = [];
    const ex = new WorkflowExecutor({
      estDesabonne: jamaisDesabonne,
      runs,
      getGraph: async () => graph,
      applyTag: async (_t, _w, tag) => { calls.push(`tag:${tag}`); },
      setField: async (_t, _w, k, v) => { calls.push(`field:${k}=${v}`); },
      removeTag: async (_t, _w, tag) => { calls.push(`untag:${tag}`); },
      clearField: async (_t, _w, k) => { calls.push(`clear:${k}`); },
      sendTemplate: async (_t, _w, name) => { calls.push(`tpl:${name}`); },
      sendQuickMessage: async (_t, _w, body) => { calls.push(`qm:${body}`); },
      sendFlow: async (_t, _w, flowId) => { calls.push(`flow:${flowId}`); },
      sendQuestion: async () => {},
      evalContext: async (_t, _w, besoins) => { surBesoins?.(besoins); return ctx; },
      ...(now ? { now } : {}),
    });
    return { ex, runs, calls };
  }
  const baseCtx = (over: Partial<EvalContext> = {}): EvalContext => ({
    fields: {}, tags: [], optIn: 'unknown', name: null, phone: null, bsuid: null,
    now: new Date('2026-08-02T14:30:00Z'), timeZone: 'Europe/Paris',
    businessHours: {
      '0': { closed: true, open: '', close: '' }, '1': { closed: false, open: '09:00', close: '18:00' },
      '2': { closed: false, open: '09:00', close: '18:00' }, '3': { closed: false, open: '09:00', close: '18:00' },
      '4': { closed: false, open: '09:00', close: '18:00' }, '5': { closed: false, open: '09:00', close: '18:00' },
      '6': { closed: true, open: '', close: '' },
    },
    ...over,
  });
  // condition(vip ?) --true--> tag gold ; --false--> tag std
  const condGraph: WorkflowGraph = {
    nodes: [n('c', 'condition', { match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] }), n('g', 'tag', { tag: 'gold' }), n('s', 'tag', { tag: 'std' })],
    edges: [eh('e1', 'c', 'g', 'true'), eh('e2', 'c', 's', 'false')],
  };

  it('start : condition à l\'entrée route selon le ctx (vrai -> gold)', async () => {
    const { ex, calls } = makeEval(condGraph, baseCtx({ tags: ['vip'] }));
    await ex.start('t1', 'wf1', condGraph, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tag:gold']);
  });
  it('start : condition fausse -> branche std', async () => {
    const { ex, calls } = makeEval(condGraph, baseCtx({ tags: [] }));
    await ex.start('t1', 'wf1', condGraph, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tag:std']);
  });
  it('advance : condition APRÈS un template route selon le ctx', async () => {
    const g: WorkflowGraph = {
      nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('c', 'condition', { match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] }), n('g', 'tag', { tag: 'gold' }), n('s', 'tag', { tag: 'std' })],
      edges: [e('e0', 'tpl', 'c'), eh('e1', 'c', 'g', 'true'), eh('e2', 'c', 's', 'false')],
    };
    const { ex, calls } = makeEval(g, baseCtx({ tags: ['vip'] }));
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tpl:promo']);
    await ex.advance('t1', '33600', 'm1');
    expect(calls).toEqual(['tpl:promo', 'tag:gold']);
  });
  it('start : bloc field NOW -> setField reçoit l\'instant DANS LE FUSEAU de l\'espace', async () => {
    // Le format a changé le 2026-09-02 : ISO 8601 avec le décalage, et non plus de l'UTC. Même instant, mais
    // l'heure lue est enfin la bonne pour qui reçoit la valeur.
    const g: WorkflowGraph = { nodes: [n('f', 'field', { fieldKey: 'vu_le', valueKind: 'now' })], edges: [] };
    const { ex, calls } = makeEval(g, baseCtx({ now: new Date('2026-08-02T14:30:00Z') }));
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['field:vu_le=2026-08-02T16:30:00+02:00']);
  });

  it('start : bloc field DERNIÈRE SAISIE -> le message écrit par le contact, tel quel', async () => {
    const g: WorkflowGraph = { nodes: [n('f', 'field', { fieldKey: 'demande', valueKind: 'derniere_saisie' })], edges: [] };
    const { ex, calls } = makeEval(g, baseCtx({ derniereSaisie: 'je voudrais changer ma commande' }));
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['field:demande=je voudrais changer ma commande']);
  });

  it('🔴 la DERNIÈRE SAISIE n\'est demandée que si un bloc s\'en sert', async () => {
    // Elle coûte une requête de plus, et l'immense majorité des scénarios n'en a que faire. Sans ce tri, tout
    // scénario portant une CONDITION la paierait, alors qu'il n'y touche pas.
    const avec: WorkflowGraph = { nodes: [n('f', 'field', { fieldKey: 'demande', valueKind: 'derniere_saisie' })], edges: [] };
    const sans: WorkflowGraph = { nodes: [n('f', 'field', { fieldKey: 'vu_le', valueKind: 'now' })], edges: [] };
    for (const [g, attendu] of [[avec, true], [sans, false]] as Array<[WorkflowGraph, boolean]>) {
      const besoins: Array<{ derniereSaisie: boolean } | undefined> = [];
      const { ex } = makeEval(g, baseCtx(), (b) => besoins.push(b));
      await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
      expect(besoins[0]?.derniereSaisie, attendu ? 'réclamée' : 'pas réclamée').toBe(attendu);
    }
  });
  it('evalContext renvoie null (contact introuvable) -> branche false déterministe', async () => {
    const { ex, calls } = makeEval(condGraph, null);
    await ex.start('t1', 'wf1', condGraph, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tag:std']);
  });
  it('start : une BRANCHE de condition qui OUVRE par quick_message reste refusée par la garde 24h (aucun envoi, aucun run)', async () => {
    // condition (clauses vide -> all -> true) --true--> quick_message (ouverture session) ; --false--> template
    const g: WorkflowGraph = {
      nodes: [n('c', 'condition', { match: 'all', clauses: [] }), n('q', 'quick_message', { body: 'Salut', quickReplies: ['Oui'] }), n('tpl', 'template', { templateName: 'p' })],
      edges: [eh('e1', 'c', 'q', 'true'), eh('e2', 'c', 'tpl', 'false')],
    };
    const { ex, runs, calls } = makeEval(g, baseCtx());
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual([]);
    expect(runs.run).toBeNull();
  });

  /**
   * 🔴 LA GARDE DU BLOC ATTENTE DATÉ (2026-09-08). Un bloc « aux prochaines heures ouvrées » ne peut rien
   * calculer sans le contexte (instant courant, fuseau, horaires de l'espace) : sans lui il devient un
   * passe-plat et envoie à 1 h du matin exactement ce que le client voulait retenir. Or ce contexte n'est
   * construit QUE si le graphe le réclame. Ce n'est donc pas le bloc qui garantit la fonctionnalité, c'est
   * cette ligne-là de `buildCtx`, et rien d'autre ne la surveille.
   */
  describe('bloc Attente daté : le contexte est RÉCLAMÉ, sinon la fonctionnalité n’existe pas', () => {
    const nuit = () => baseCtx({ now: new Date('2026-09-07T23:00:00Z') }); // mardi 1 h du matin à Paris
    const attente = (data: Record<string, unknown>): WorkflowGraph => ({
      nodes: [n('w', 'wait', data), n('tpl', 'template', { templateName: 'promo' })],
      edges: [e('e1', 'w', 'tpl')],
    });

    it('🔴 « heures ouvrées » : evalContext est appelé, et le parcours dort jusqu’à 9 h', async () => {
      const appels: Array<{ derniereSaisie: boolean } | undefined> = [];
      const g = attente({ waitMode: 'heures_ouvrees' });
      const { ex, runs, calls } = makeEval(g, nuit(), (b) => appels.push(b), () => nuit().now.getTime());
      await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
      expect(appels).toHaveLength(1); // sans la ligne de `buildCtx`, aucun appel : c'est la mutation qui compte
      expect(calls).toEqual([]); // le template ne part PAS maintenant
      expect(runs.dernierEtat?.status).toBe('sleeping');
      expect(runs.dernierEtat?.resumeAt?.toISOString()).toBe('2026-09-08T07:00:00.000Z'); // 9 h à Paris
    });

    it('🔴 « date précise » : même garde, même réclamation du contexte', async () => {
      const appels: Array<{ derniereSaisie: boolean } | undefined> = [];
      const g = attente({ waitMode: 'date', waitDate: '2026-09-10T09:00' });
      const { ex, runs } = makeEval(g, nuit(), (b) => appels.push(b), () => nuit().now.getTime());
      await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
      expect(appels).toHaveLength(1);
      expect(runs.dernierEtat?.resumeAt?.toISOString()).toBe('2026-09-10T07:00:00.000Z');
    });

    it('une attente en DÉLAI ne réclame toujours rien : on n’a pas fait payer une requête à tout le monde', async () => {
      // La contrepartie du cas ci-dessus. Sans elle, on aurait pu « corriger » en construisant le contexte
      // pour tous les scénarios, ce qui remettrait deux requêtes par étape sur l'immense majorité d'entre eux.
      const appels: Array<{ derniereSaisie: boolean } | undefined> = [];
      const g = attente({ delay: 2, unit: 'hours' });
      const { ex, runs } = makeEval(g, nuit(), (b) => appels.push(b), () => nuit().now.getTime());
      await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
      expect(appels).toHaveLength(0);
      expect(runs.dernierEtat?.status).toBe('sleeping');
    });
  });
});

/**
 * INVARIANT le plus coûteux du lot Automation : un tag posé par un scénario ne publie « tag ajouté » QUE si ce
 * scénario a été lancé pour UN contact. Le même exécuteur sert les campagnes : sans ce garde-fou, une campagne
 * workflow de 5 000 destinataires dont le graphe contient un bloc Action publierait 5 000 événements, donc
 * potentiellement 5 000 scénarios et autant de messages facturés que personne n'a demandés.
 */
describe('publication « tag ajouté » : gouvernée par le CHEMIN, pas par l’action', () => {
  const graphe: WorkflowGraph = { nodes: [n('t', 'tag', { tag: 'vip' })], edges: [] };

  function exec(over: Partial<WorkflowExecutorDeps> = {}) {
    const emitted: string[] = [];
    const deps: WorkflowExecutorDeps = {
      estDesabonne: jamaisDesabonne,
      runs: { start: async () => ({ id: 'r1' }), findWaitingByWaId: async () => null, setState: async () => {}, closeActiveByWaId: async () => [] },
      getGraph: async () => graphe,
      applyTag: async () => true, // le tag est réellement nouveau
      setField: async () => {}, removeTag: async () => {}, clearField: async () => {},
      sendTemplate: async () => {}, sendQuickMessage: async () => {}, sendFlow: async () => {}, sendQuestion: async () => {},
      emitTagAdded: async (_t, _w, tag) => { emitted.push(tag); },
      ...over,
    };
    return { ex: new WorkflowExecutor(deps), emitted };
  }

  it('CAMPAGNE (start sans option) -> AUCUNE publication', async () => {
    const { ex, emitted } = exec();
    await ex.start('t1', 'wf1', graphe, { waId: '33611', contactId: 'c1' });
    expect(emitted).toEqual([]);
  });

  it('campagne ciblant un bloc (startFromNode sans option) -> AUCUNE publication', async () => {
    const { ex, emitted } = exec();
    await ex.startFromNode('t1', 'wf1', graphe, { waId: '33611', contactId: 'c1' }, 't');
    expect(emitted).toEqual([]);
  });

  it('démarrage UNITAIRE (automation / test) -> publication', async () => {
    const { ex, emitted } = exec();
    await ex.startInWindow('t1', 'wf1', graphe, { waId: '33611', contactId: 'c1' }, { emitEvents: true });
    expect(emitted).toEqual(['vip']);
  });

  it('tag DÉJÀ présent (applyTag renvoie false) -> aucune publication même en unitaire', async () => {
    const { ex, emitted } = exec({ applyTag: async () => false });
    await ex.startInWindow('t1', 'wf1', graphe, { waId: '33611', contactId: 'c1' }, { emitEvents: true });
    expect(emitted).toEqual([]);
  });

  it('une publication qui échoue ne fait pas échouer le parcours', async () => {
    const { ex } = exec({ emitTagAdded: async () => { throw new Error('file indisponible'); } });
    await expect(ex.startInWindow('t1', 'wf1', graphe, { waId: '33611', contactId: 'c1' }, { emitEvents: true })).resolves.toBe(true);
  });
});

describe('WorkflowExecutor.resume (réveil après un bloc Attente)', () => {
  const n2 = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });

  /** tag -> attente -> <suite>. Le run dort sur 'w', la reprise doit repartir de la suite. */
  const grapheAvecSuite = (suite: ReturnType<typeof n2>): WorkflowGraph => ({
    nodes: [n2('t', 'tag', { tag: 'vip' }), n2('w', 'wait', { delay: 2, unit: 'hours' }), suite],
    edges: [{ id: 'e1', source: 't', target: 'w' }, { id: 'e2', source: 'w', target: suite.id }],
  });

  function makeResume(graph: WorkflowGraph, over: Partial<WorkflowExecutorDeps> = {}) {
    const runs = new FakeRuns();
    runs.run = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'w', status: 'sleeping', lastMessageId: null };
    const calls: string[] = [];
    const escalations: string[] = [];
    const emis: string[] = []; // événements d'automation publiés (tag ajouté)
    const ex = new WorkflowExecutor({
      estDesabonne: jamaisDesabonne,
      runs,
      getGraph: async () => graph,
      applyTag: async (_t, _w, tag) => { calls.push(`tag:${tag}`); return true; },
      setField: async () => {},
      removeTag: async () => {},
      clearField: async () => {},
      sendTemplate: async (_t, _w, name) => { calls.push(`tpl:${name}`); },
      sendQuickMessage: async (_t, _w, body) => { calls.push(`qm:${body}`); },
      sendFlow: async (_t, _w, id) => { calls.push(`flow:${id}`); },
      sendQuestion: async () => {},
      escalateToHuman: async (_t, w) => { escalations.push(w); },
      emitTagAdded: async (_t, _w, tag) => { emis.push(tag); },
      ...over,
    });
    const run = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'w' };
    return { ex, runs, calls, escalations, emis, run };
  }

  it('reprend au bloc SUIVANT l’attente, jamais sur l’attente elle-même (sinon le parcours se rendort en boucle)', async () => {
    const { ex, runs, calls, run } = makeResume(grapheAvecSuite(n2('tpl', 'template', { templateName: 'relance' })));
    expect(await ex.resume(run)).toBe(true);
    expect(calls).toEqual(['tpl:relance']);
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'tpl' });
  });

  /**
   * La fenêtre de 24 h est une règle de META. Un parcours dont le canal courant est le RCS envoie son message
   * rapide par le canal RCS, qui n'a aucune fenêtre : la lui imposer bloquait un envoi légitime, tuait le
   * parcours et remontait la conversation en inbox avec un log qui parlait de WhatsApp.
   *
   * Ce défaut ne s'est révélé qu'une fois le calcul de fenêtre restreint au canal WhatsApp (bf0408d) : avant,
   * un retour RCS ouvrait la fenêtre WhatsApp et le masquait.
   */
  const rcsQuiMarche = (envoyes: string[]) => ({
    rcs: {
      agentIdFor: async () => 'agent-1',
      sender: { sendTo: async (_t: string, _a: string, _w: string, m: { text?: string }) => { envoyes.push(`rcs:${m.text}`); return { messageId: 'm-rcs' }; } },
    },
  } as unknown as Partial<WorkflowExecutorDeps>);

  it('🔴 parcours sur canal RCS : le message rapide part EN RCS, la fenêtre WhatsApp n’est même pas interrogée', async () => {
    const envoyes: string[] = [];
    let fenetreInterrogee = false;
    const suite = n2('qm', 'quick_message', { body: 'Alors ?', quickReplies: ['Oui'] });
    const { ex, runs, calls } = makeResume(grapheAvecSuite(suite), {
      isWindowOpen: async () => { fenetreInterrogee = true; return false; },
      ...rcsQuiMarche(envoyes),
    });
    runs.run = { ...runs.run!, channel: 'rcs' } as typeof runs.run;

    expect(await ex.resume({ id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'w', channel: 'rcs' } as never)).toBe(true);
    expect(envoyes).toEqual(['rcs:Alors ?']);   // parti par le bon tuyau
    expect(calls).toEqual([]);                   // et surtout PAS par WhatsApp
    expect(fenetreInterrogee).toBe(false);       // une règle Meta n'a rien à dire ici
  });

  it('🔴 canal RCS mais un TEMPLATE d’abord : le message rapide REDEVIENT soumis à la fenêtre', async () => {
    // Test de non-régression du correctif naïf. `apply` ramène le parcours sur WhatsApp après un template
    // réussi (c'est la manière documentée de changer de canal) : exempter le message rapide au seul motif que
    // le run a démarré en RCS enverrait donc un message que Meta refuserait en 131047, et le parcours
    // continuerait sur un message jamais reçu.
    const envoyes: string[] = [];
    const suite = n2('qm', 'quick_message', { body: 'Alors ?', quickReplies: ['Oui'] });
    const graph: WorkflowGraph = {
      nodes: [n2('t', 'tag', { tag: 'vip' }), n2('w', 'wait', { delay: 2, unit: 'hours' }), n2('tpl', 'template', { templateName: 'relance' }), suite],
      edges: [
        { id: 'e1', source: 't', target: 'w' },
        { id: 'e2', source: 'w', target: 'tpl' },
        { id: 'e3', source: 'tpl', target: 'qm' },
      ],
    };
    const { ex, runs, calls, escalations } = makeResume(graph, {
      isWindowOpen: async () => false,
      mbaActifPour: async () => true, // laisse un template SANS bouton poursuivre le walk
      ...rcsQuiMarche(envoyes),
    });
    runs.run = { ...runs.run!, channel: 'rcs' } as typeof runs.run;

    await ex.resume({ id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'w', channel: 'rcs' } as never);
    expect(calls).toContain('tpl:relance');  // le template part, il n'a pas besoin de la fenêtre
    expect(envoyes).toEqual([]);             // et le message rapide ne part PAS en RCS…
    expect(calls).not.toContain('qm:Alors ?'); // …ni en WhatsApp : la fenêtre est fermée
    expect(escalations).toEqual(['33600']);
  });

  it('canal RCS : un FORMULAIRE reste soumis à la fenêtre (aucun équivalent RCS)', async () => {
    const envoyes: string[] = [];
    const suite = n2('fl', 'flow', { flowId: 'f1', body: 'Remplis', cta: 'Ouvrir' });
    const { ex, runs, calls, escalations } = makeResume(grapheAvecSuite(suite), {
      isWindowOpen: async () => false,
      ...rcsQuiMarche(envoyes),
    });
    runs.run = { ...runs.run!, channel: 'rcs' } as typeof runs.run;

    await ex.resume({ id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'w', channel: 'rcs' } as never);
    expect(calls).toEqual([]);
    expect(envoyes).toEqual([]);
    expect(escalations).toEqual(['33600']);
  });

  it('un TEMPLATE part même hors fenêtre 24 h : c’est tout son intérêt', async () => {
    const { ex, calls, run } = makeResume(grapheAvecSuite(n2('tpl', 'template', { templateName: 'relance' })), {
      isWindowOpen: async () => false,
    });
    expect(await ex.resume(run)).toBe(true);
    expect(calls).toEqual(['tpl:relance']);
  });

  it('un MESSAGE RAPIDE hors fenêtre n’est PAS envoyé, et la conversation part en inbox', async () => {
    const suite = n2('qm', 'quick_message', { body: 'Alors ?', quickReplies: ['Oui'] });
    const { ex, runs, calls, escalations, run } = makeResume(grapheAvecSuite(suite), { isWindowOpen: async () => false });
    expect(await ex.resume(run)).toBe(false);
    expect(calls).toEqual([]); // rien n'est parti
    expect(runs.run).toMatchObject({ status: 'inbox' });
    expect(escalations).toEqual(['33600']);
  });

  it('même message rapide, mais fenêtre OUVERTE -> envoyé normalement', async () => {
    const suite = n2('qm', 'quick_message', { body: 'Alors ?', quickReplies: ['Oui'] });
    const { ex, calls, run } = makeResume(grapheAvecSuite(suite), { isWindowOpen: async () => true });
    expect(await ex.resume(run)).toBe(true);
    expect(calls).toEqual(['qm:Alors ?']);
  });

  it('SANS dep de fenêtre -> fenêtre considérée FERMÉE (on préfère ne rien envoyer qu’un envoi refusé par Meta)', async () => {
    const suite = n2('qm', 'quick_message', { body: 'Alors ?', quickReplies: ['Oui'] });
    const { ex, calls, run } = makeResume(grapheAvecSuite(suite));
    expect(await ex.resume(run)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('fil repris par un humain pendant l’attente -> aucune action, run clos', async () => {
    const { ex, runs, calls, run } = makeResume(grapheAvecSuite(n2('tpl', 'template', { templateName: 'relance' })), {
      mayAct: async () => false,
    });
    expect(await ex.resume(run)).toBe(false);
    expect(calls).toEqual([]);
    expect(runs.run).toMatchObject({ status: 'done' });
  });

  it('bloc supprimé du graphe pendant l’attente -> run clos, jamais laissé dormant', async () => {
    const { ex, runs, run } = makeResume({ nodes: [n2('autre', 'tag', { tag: 'x' })], edges: [] });
    expect(await ex.resume(run)).toBe(false);
    expect(runs.run).toMatchObject({ status: 'done' });
  });

  it('attente en fin de chaîne (aucune suite) -> run clos', async () => {
    const graph: WorkflowGraph = { nodes: [n2('w', 'wait', { delay: 1, unit: 'hours' })], edges: [] };
    const { ex, runs, run } = makeResume(graph);
    expect(await ex.resume(run)).toBe(false);
    expect(runs.run).toMatchObject({ status: 'done' });
  });

  it('la reprise PUBLIE l’événement « tag ajouté », comme après une réponse du contact', async () => {
    // Un réveil est unitaire par nature (un contact, ici et maintenant). Sans ça, « attendre 1 jour puis poser
    // le tag relance » ne déclencherait pas l'automation branchée dessus, alors que le MÊME tag posé après une
    // réponse la déclenche. Les campagnes, elles, n'émettent pas (5 000 destinataires = 5 000 événements).
    const graph: WorkflowGraph = {
      nodes: [n2('w', 'wait', { delay: 1, unit: 'hours' }), n2('tg', 'tag', { tag: 'relance_j1' })],
      edges: [{ id: 'e1', source: 'w', target: 'tg' }],
    };
    const { ex, calls, emis, run } = makeResume(graph);
    expect(await ex.resume(run)).toBe(true);
    expect(calls).toEqual(['tag:relance_j1']);
    expect(emis).toEqual(['relance_j1']);
  });

  it('envoi REFUSÉ au réveil -> run clos et conversation remontée à un humain', async () => {
    // Laisser le run en attente le ferait repartir au bloc SUIVANT dès que le contact écrirait, en réponse à
    // un message qu'il n'a jamais reçu.
    const { ex, runs, escalations, run } = makeResume(
      grapheAvecSuite(n2('tpl', 'template', { templateName: 'relance' })),
      { sendTemplate: async () => 'template « relance » introuvable chez Meta' },
    );
    expect(await ex.resume(run)).toBe(false);
    expect(runs.run).toMatchObject({ status: 'inbox' });
    expect(escalations).toEqual(['33600']);
  });

  it('fenêtre fermée : le message de session est sauté, mais le TEMPLATE et le tag partent quand même', async () => {
    // Régression introduite en rendant les messages sans bouton non bloquants : un réveil peut désormais
    // produire « message rapide + tag + template » d'un coup. La garde fenêtre jetait le LOT ENTIER, donc un
    // template, qui n'a pourtant pas besoin de la fenêtre, ne partait plus. On n'écarte que ce qui est refusé.
    const graph: WorkflowGraph = {
      nodes: [
        n2('w', 'wait', { delay: 1, unit: 'hours' }),
        n2('qm', 'quick_message', { body: 'un mot' }),
        n2('tg', 'tag', { tag: 'relance' }),
        n2('tpl', 'template', { templateName: 'promo' }),
      ],
      edges: [{ id: 'e1', source: 'w', target: 'qm' }, { id: 'e2', source: 'qm', target: 'tg' }, { id: 'e3', source: 'tg', target: 'tpl' }],
    };
    // Pas d'`isWindowOpen` dans les deps -> fenêtre considérée FERMÉE (fail-closed), le cas qui nous intéresse.
    const { ex, runs, calls, escalations, run } = makeResume(graph);
    expect(await ex.resume(run)).toBe(false);
    expect(calls).toEqual(['tag:relance', 'tpl:promo']); // le message rapide, lui, n'est pas parti
    expect(runs.run).toMatchObject({ status: 'inbox' });
    expect(escalations).toEqual(['33600']);
  });

  it('DEUX attentes à la suite : la reprise redort, avec la nouvelle échéance', async () => {
    const graph: WorkflowGraph = {
      nodes: [n2('w', 'wait', { delay: 1, unit: 'hours' }), n2('w2', 'wait', { delay: 3, unit: 'minutes' }), n2('tpl', 'template', { templateName: 'p' })],
      edges: [{ id: 'e1', source: 'w', target: 'w2' }, { id: 'e2', source: 'w2', target: 'tpl' }],
    };
    const { ex, runs, run } = makeResume(graph, { now: () => 1_000_000 });
    expect(await ex.resume(run)).toBe(true);
    expect(runs.run).toMatchObject({ status: 'sleeping', currentNode: 'w2' });
  });
});

/**
 * Un envoi REFUSÉ à l'intérieur d'un scénario ne doit jamais être compté comme parti.
 *
 * Le refus est décidé dans le worker (visuel de carte non re-téléversable, variable sans valeur, template
 * absent chez Meta). Il n'existait que dans les logs : la campagne affichait « envoyé » avec l'identifiant
 * synthétique `wf-<id>` et rien n'arrivait sur le téléphone. Vécu trois fois en production le 2026-08-15.
 */
describe('WorkflowExecutor : remontée d’un envoi refusé', () => {
  const linear: WorkflowGraph = {
    nodes: [n('t', 'tag', { tag: 'vip' }), n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('ib', 'inbox')],
    edges: [e('e1', 't', 'tpl'), e('e2', 'tpl', 'ib')],
  };
  const RAISON = 'template « promo » : l’image de la carte 2 n’a pas pu être préparée pour l’envoi';

  it('start : la raison EXACTE remonte à l’appelant (c’est elle que la campagne affiche)', async () => {
    const { ex } = make(linear, { sendTemplate: async () => RAISON });
    expect(await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' })).toBe(RAISON);
  });

  it('start refusé : AUCUN run en attente n’est laissé derrière', async () => {
    // Sinon il attendrait une réponse à un message jamais reçu, et le premier message du contact le ferait
    // repartir au bloc SUIVANT, sorti de nulle part.
    const { ex, runs } = make(linear, { sendTemplate: async () => RAISON });
    await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' });
    expect(runs.run).toBeNull();
  });

  it('start refusé : les actions synchrones déjà appliquées le restent (on ne les rejoue pas)', async () => {
    const { ex, calls } = make(linear, { sendTemplate: async () => RAISON });
    await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tag:vip']);
  });

  it('start qui PASSE : toujours `true`, run en attente au template (non-régression)', async () => {
    const { ex, runs } = make(linear);
    expect(await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' })).toBe(true);
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'tpl' });
  });

  it('une chaîne VIDE rendue par un câblage n’est pas un refus', async () => {
    const { ex, runs } = make(linear, { sendTemplate: async () => '' });
    expect(await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' })).toBe(true);
    expect(runs.run).toMatchObject({ status: 'waiting' });
  });

  it('advance : envoi refusé -> run clos et conversation remontée à un humain', async () => {
    const g: WorkflowGraph = {
      nodes: [n('tpl1', 'template', { templateName: 'a', language: 'fr' }), n('tpl2', 'template', { templateName: 'b', language: 'fr' })],
      edges: [e('e1', 'tpl1', 'tpl2')],
    };
    let refuse = false;
    const { ex, runs, escalations } = make(g, { sendTemplate: async () => (refuse ? 'variable sans valeur pour ce contact' : undefined) });
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    refuse = true;
    await ex.advance('t1', '33600', 'm1');
    expect(runs.run).toMatchObject({ status: 'inbox', currentNode: null });
    expect(escalations).toEqual(['33600']);
  });
});

/**
 * Reproduction du cas de production du 2026-08-15 (scénario « julien test2 ») : après une réponse rapide, un
 * bloc « message rapide » SANS bouton suivi d'un bloc « Action : poser le tag ». Le tag n'était jamais posé.
 */
describe('WorkflowExecutor : un message rapide sans bouton ne bloque plus le parcours', () => {
  it('message sans bouton puis tag : les deux partent, le run se termine', async () => {
    const g: WorkflowGraph = {
      nodes: [
        n('qm', 'quick_message', { body: 're ganial' }),
        n('tg', 'action', { actionKind: 'add_tag', tag: 'genial' }),
      ],
      edges: [e('e1', 'qm', 'tg')],
    };
    const { ex, runs, calls } = make(g);
    await ex.startInWindow('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['qm:re ganial', 'tag:genial']);
    expect(runs.run).toBeNull(); // parcours 100 % synchrone -> aucun run en attente à laisser derrière
  });

  it('après une réponse rapide (advance), le tag qui suit le message est bien posé', async () => {
    // Le vrai enchaînement de Julien : un message à boutons, la branche du bouton, puis message + tag.
    const g: WorkflowGraph = {
      nodes: [
        n('q1', 'quick_message', { body: 'Ça te va ?', quickReplies: ['toussa'] }),
        n('q2', 'quick_message', { body: 're ganial' }),
        n('tg', 'action', { actionKind: 'add_tag', tag: 'genial' }),
      ],
      edges: [eh('e1', 'q1', 'q2', 'btn:0'), e('e2', 'q2', 'tg')],
    };
    const { ex, calls } = make(g);
    await ex.startInWindow('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['qm:Ça te va ?']); // on attend le choix
    await ex.advance('t1', '33600', 'm1', 'btn:0');
    expect(calls).toEqual(['qm:Ça te va ?', 'qm:re ganial', 'tag:genial']);
  });

  it('un envoi refusé APRÈS un envoi réussi ne fait pas passer le parcours pour mort', async () => {
    // Un walk peut désormais produire plusieurs envois. Si le premier part et le second est refusé, le contact
    // a bien reçu quelque chose : on ne remonte pas d'échec à la campagne et on ne clôt pas le run.
    const g: WorkflowGraph = {
      nodes: [
        n('q1', 'quick_message', { body: 'parti' }),
        n('tpl', 'template', { templateName: 'promo', language: 'fr' }),
      ],
      edges: [e('e1', 'q1', 'tpl')],
    };
    const { ex, runs } = make(g, { sendTemplate: async () => 'template introuvable chez Meta' });
    expect(await ex.startInWindow('t1', 'wf1', g, { waId: '33600', contactId: 'c1' })).toBe(true);
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'tpl' });
  });

  it('mais si RIEN ne part, la raison remonte toujours et aucun run n’est laissé', async () => {
    const g: WorkflowGraph = {
      nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr' })],
      edges: [],
    };
    const { ex, runs } = make(g, { sendTemplate: async () => 'template introuvable chez Meta' });
    expect(await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' })).toBe('template introuvable chez Meta');
    expect(runs.run).toBeNull();
  });
});

/**
 * Tâche 10 : quand le contact répond pendant une conversation tenue par l'agent, `advance` doit ENFILER UN
 * TOUR au lieu de router dans le graphe.
 *
 * 🔴 C'est le chemin le plus chaud du produit. Sans la branche, `sortieTypee` ne connaît que `sent` et
 * `unreachable`, donc il est faux pour un bloc agent, et deux issues suivent, fatales toutes les deux : une
 * arête libre partant du bloc fait SAUTER l'agent dès le premier message, sinon le run est clos en `done` et
 * la conversation part à l'agent de Meta. Dans les deux cas la session reste vivante et orpheline en base.
 */
describe('advance : le bloc agent rend la main au tour (tâche 10)', () => {
  const SESSION = { id: 's1', tenantId: 't1', runId: 'r1', agentId: 'ag1', nodeId: 'a', waId: '33600', tours: 3, appelsOutils: 0, coutMicroEur: 0, status: 'en_cours' as const };

  // agent 'a' -> quick_message 'b' par une arête SANS handle : c'est le montage qui fait sauter le bloc.
  const avecAreteLibre: WorkflowGraph = {
    nodes: [n('a', 'agent', { agentId: 'ag1' }), n('b', 'quick_message', { body: 'apres' })],
    edges: [e('e1', 'a', 'b')],
  };

  const poserRunSurAgent = (runs: { run: WorkflowRunRow | null }) => {
    runs.run = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'a', status: 'waiting', lastMessageId: null };
  };

  const deps = (over: Partial<WorkflowExecutorDeps> = {}) => {
    const jobs: AgentTurnJob[] = [];
    return {
      jobs,
      over: {
        agentSessions: { byRun: async () => SESSION } as unknown as WorkflowExecutorDeps['agentSessions'],
        enqueueAgentTurn: async (j: AgentTurnJob) => { jobs.push(j); },
        ...over,
      },
    };
  };

  it('enfile un tour au lieu de router, avec la raison, le bloc et le tour attendu', async () => {
    const { jobs, over } = deps();
    const { ex, runs } = make(avecAreteLibre, over);
    poserRunSurAgent(runs);
    await ex.advance('t1', '33600', 'msg1');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ raison: 'message', nodeId: 'a', sessionId: 's1', runId: 'r1', tenantId: 't1', waId: '33600', tours: 3 });
  });

  it('🔴 ne SAUTE PAS le bloc agent quand une arête libre en part', async () => {
    const { over } = deps();
    const { ex, runs, calls } = make(avecAreteLibre, over);
    poserRunSurAgent(runs);
    await ex.advance('t1', '33600', 'msg1');
    expect(calls).toEqual([]); // le quick_message d'après ne doit PAS partir
    expect(runs.run).toMatchObject({ currentNode: 'a', status: 'waiting' });
  });

  it('🔴 sans arête sortante, ne clôt pas le run et ne rend pas la main à l agent de Meta', async () => {
    const seul: WorkflowGraph = { nodes: [n('a', 'agent', { agentId: 'ag1' })], edges: [] };
    const rendus: string[] = [];
    const { jobs, over } = deps({ releaseToMba: async (_t: string, w: string) => { rendus.push(w); } });
    const { ex, runs } = make(seul, over);
    poserRunSurAgent(runs);
    await ex.advance('t1', '33600', 'msg1');
    expect(runs.run).toMatchObject({ currentNode: 'a', status: 'waiting' });
    expect(rendus).toEqual([]);
    expect(jobs).toHaveLength(1);
  });

  it('persiste lastMessageId : un rejeu du même message n enfile pas un second tour', async () => {
    const { jobs, over } = deps();
    const { ex, runs } = make(avecAreteLibre, over);
    poserRunSurAgent(runs);
    await ex.advance('t1', '33600', 'msg1');
    await ex.advance('t1', '33600', 'msg1');
    expect(jobs).toHaveLength(1);
  });

  it('🔴 si l enfilage ÉCHOUE, lastMessageId n est PAS marqué : la redélivrance peut retenter', async () => {
    // Ordre voulu : on enfile AVANT de marquer le message consommé. Avec l'ordre inverse, une panne
    // transitoire de la file laisserait `lastMessageId` écrit, la redélivrance serait dédupliquée, et le tour
    // ne serait JAMAIS enfilé : conversation bloquée jusqu'à ce que le contact réécrive de lui-même.
    const { over } = deps({ enqueueAgentTurn: async () => { throw new Error('file indisponible'); } });
    const { ex, runs } = make(avecAreteLibre, over);
    poserRunSurAgent(runs);
    await expect(ex.advance('t1', '33600', 'msg1')).rejects.toThrow('file indisponible');
    expect(runs.run?.lastMessageId).toBeNull();
  });

  it('session absente ou close : remonte en inbox, escalade, et n enfile aucun tour', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { jobs, over } = deps({
      agentSessions: { byRun: async () => null } as unknown as WorkflowExecutorDeps['agentSessions'],
    });
    const { ex, runs, escalations } = make(avecAreteLibre, over);
    poserRunSurAgent(runs);
    await ex.advance('t1', '33600', 'msg1');
    expect(runs.run).toMatchObject({ currentNode: null, status: 'inbox' });
    expect(escalations).toEqual(['33600']);
    expect(jobs).toEqual([]);
    spy.mockRestore();
  });
});

/**
 * Tâche 11 : quand un réveil d'attente atteint un bloc agent, il faut OUVRIR la session et enfiler le premier
 * tour. `restToState` met déjà le run en attente sur le bloc (tâche 7) ; c'est le démarrage qui manque.
 *
 * L'ordre est l'inverse de celui d'`advance` : ici on enfile APRÈS l'écriture d'état, parce que le claim du
 * balayage est un BAIL et qu'un rejeu de `resume` renverrait les messages déjà partis.
 */
describe('resume : le bloc agent ouvre sa session (tâche 11)', () => {
  const SESSION = { id: 's9', tenantId: 't1', runId: 'r1', agentId: 'ag1', nodeId: 'a', waId: '33600', tours: 0, appelsOutils: 0, coutMicroEur: 0, status: 'en_cours' as const };

  // attente -> agent : le montage exact que la tâche vise.
  const attenteAgent: WorkflowGraph = {
    nodes: [n('w', 'wait', { delay: 1, unit: 'hours' }), n('a', 'agent', { agentId: 'ag1' })],
    edges: [e('e1', 'w', 'a')],
  };

  const sessionsFake = (over: { byRun?: () => Promise<unknown> } = {}) => {
    const ouvertures: unknown[] = [];
    const store = {
      byRun: over.byRun ?? (async () => null),
      open: async (input: unknown) => { ouvertures.push(input); return SESSION; },
    } as unknown as WorkflowExecutorDeps['agentSessions'];
    return { store, ouvertures };
  };

  const runDormant = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'w', status: 'sleeping' as const };

  it('le réveil ouvre la session et enfile un tour « demarrage »', async () => {
    const jobs: AgentTurnJob[] = [];
    const { store, ouvertures } = sessionsFake();
    const { ex, runs } = make(attenteAgent, { agentSessions: store, enqueueAgentTurn: async (j: AgentTurnJob) => { jobs.push(j); }, isWindowOpen: async () => true });
    // Le run doit être SEMÉ dans le fake : `FakeRuns.setState` ne mute que si `this.run` existe déjà. Sans ce
    // seeding, l'assertion d'état plus bas porterait sur `null` et ne prouverait rien.
    runs.run = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'w', status: 'sleeping', lastMessageId: null };
    expect(await ex.resume(runDormant)).toBe(true);
    expect(ouvertures).toHaveLength(1);
    expect(ouvertures[0]).toMatchObject({ tenantId: 't1', runId: 'r1', agentId: 'ag1', nodeId: 'a', waId: '33600' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ raison: 'demarrage', nodeId: 'a', sessionId: 's9', runId: 'r1', tours: 0 });
    // Le run attend SUR le bloc agent, ni done ni inbox. Assertion DIRECTE, sans repli : un `?? valeur
    // attendue` rendrait ce test incapable d'échouer.
    expect(runs.run).toMatchObject({ currentNode: 'a', status: 'waiting' });
  });

  it('🔴 « attente puis agent » DIRECT, fenêtre fermée : inbox, AUCUNE session, AUCUN tour', async () => {
    // Trouvé en revue de la tâche 12 : le bloc agent ne produit AUCUNE action, donc la garde de fenêtre de
    // `resume`, qui ne regardait que les actions, le laissait passer. Le test « fenêtre fermée » précédent
    // avait un message rapide intercalaire, et c'est LUI qui déclenchait la garde : le cas direct n'était pas
    // couvert. L'agent se réveillait alors hors fenêtre, Meta refusait en 131047, et le modèle était payé
    // pour rien. Attention : l'attente déclarée ne dit rien de la fenêtre réelle, qui court depuis le dernier
    // message DU CONTACT.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const jobs: AgentTurnJob[] = [];
    const { store, ouvertures } = sessionsFake();
    const { ex, escalations } = make(attenteAgent, {
      agentSessions: store,
      enqueueAgentTurn: async (j: AgentTurnJob) => { jobs.push(j); },
      isWindowOpen: async () => false,
    });
    expect(await ex.resume(runDormant)).toBe(false);
    expect(ouvertures).toEqual([]);
    expect(jobs).toEqual([]);
    expect(escalations).toEqual(['33600']);
    spy.mockRestore();
  });

  it('🔴 fenêtre 24 h fermée : remontée en inbox, AUCUNE session ouverte et aucun tour enfilé', async () => {
    // Ouvrir avant la sortie anticipée créerait une session vivante sur un run déjà clos, que rien ne nettoie.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const jobs: AgentTurnJob[] = [];
    const { store, ouvertures } = sessionsFake();
    const g: WorkflowGraph = {
      nodes: [n('w', 'wait', { delay: 1, unit: 'hours' }), n('q', 'quick_message', { body: 'coucou' }), n('a', 'agent', { agentId: 'ag1' })],
      edges: [e('e1', 'w', 'q'), e('e2', 'q', 'a')],
    };
    const { ex, escalations } = make(g, {
      agentSessions: store,
      enqueueAgentTurn: async (j: AgentTurnJob) => { jobs.push(j); },
      isWindowOpen: async () => false,
    });
    expect(await ex.resume(runDormant)).toBe(false);
    expect(ouvertures).toEqual([]);
    expect(jobs).toEqual([]);
    expect(escalations).toEqual(['33600']);
    spy.mockRestore();
  });

  it('une session déjà vivante est RÉUTILISÉE, pas dupliquée (open lèverait sur l index partiel)', async () => {
    const jobs: AgentTurnJob[] = [];
    const { store, ouvertures } = sessionsFake({ byRun: async () => SESSION });
    const { ex } = make(attenteAgent, { agentSessions: store, enqueueAgentTurn: async (j: AgentTurnJob) => { jobs.push(j); }, isWindowOpen: async () => true });
    expect(await ex.resume(runDormant)).toBe(true);
    expect(ouvertures).toEqual([]); // aucun open
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.sessionId).toBe('s9');
  });

  it('sans store d agent branché, le réveil ne casse pas (dep optionnelle)', async () => {
    const jobs: AgentTurnJob[] = [];
    const { ex } = make(attenteAgent, { enqueueAgentTurn: async (j: AgentTurnJob) => { jobs.push(j); }, isWindowOpen: async () => true });
    expect(await ex.resume(runDormant)).toBe(true);
    expect(jobs).toEqual([]);
  });
});

/**
 * Tâche 12 : troisième et dernier site de couture. Un scénario qui OUVRE sur un bloc agent.
 *
 * 🔴 Le sujet principal n'est pas l'ouverture de la session, c'est la GARDE DE FENÊTRE. Le bloc agent ne
 * produit AUCUNE action (c'est une main rendue), donc la garde, qui ne regardait que les actions, le laissait
 * passer : une campagne froide démarrait l'agent, qui écrivait du texte libre hors fenêtre, Meta refusait en
 * 131047, et le modèle avait déjà été payé.
 */
describe('runFrom : ouverture sur un bloc agent (tâche 12)', () => {
  const SESSION12 = { id: 's12', tenantId: 't1', runId: 'rNEW', agentId: 'ag1', nodeId: 'a', waId: '33600', tours: 0, appelsOutils: 0, coutMicroEur: 0, status: 'en_cours' as const };

  const ouvreSurAgent: WorkflowGraph = { nodes: [n('a', 'agent', { agentId: 'ag1' })], edges: [] };

  const fake12 = () => {
    const ouvertures: unknown[] = [];
    const jobs: AgentTurnJob[] = [];
    const store = {
      byRun: async () => null,
      open: async (input: unknown) => { ouvertures.push(input); return SESSION12; },
    } as unknown as WorkflowExecutorDeps['agentSessions'];
    return { ouvertures, jobs, store, enqueueAgentTurn: async (j: AgentTurnJob) => { jobs.push(j); } };
  };

  it('🔴 hors fenêtre : le démarrage est REFUSÉ, aucune session, aucun tour, aucun run', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ouvertures, jobs, store, enqueueAgentTurn } = fake12();
    const { ex, runs } = make(ouvreSurAgent, { agentSessions: store, enqueueAgentTurn });
    const out = await ex.start('t1', 'wf1', ouvreSurAgent, { waId: '33600', contactId: 'c1' });
    expect(typeof out).toBe('string');
    expect(String(out)).toContain('agent IA');
    expect(ouvertures).toEqual([]);
    expect(jobs).toEqual([]);
    expect(runs.run).toBeNull(); // aucun run persisté
    spy.mockRestore();
  });

  it('en fenêtre garantie (startFromNode) : session ouverte et tour « demarrage » enfilé', async () => {
    const { ouvertures, jobs, store, enqueueAgentTurn } = fake12();
    const { ex, runs } = make(ouvreSurAgent, { agentSessions: store, enqueueAgentTurn });
    expect(await ex.startFromNode('t1', 'wf1', ouvreSurAgent, { waId: '33600', contactId: 'c1' }, 'a')).toBe(true);
    expect(ouvertures).toHaveLength(1);
    expect(ouvertures[0]).toMatchObject({ tenantId: 't1', agentId: 'ag1', nodeId: 'a', waId: '33600' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ raison: 'demarrage', nodeId: 'a', sessionId: 's12' });
    expect(runs.run).toMatchObject({ currentNode: 'a', status: 'waiting' });
  });

  it('🔴 la session porte l id du run CRÉÉ par runs.start (FK : elle ne peut pas naître avant)', async () => {
    const { ouvertures, jobs, store, enqueueAgentTurn } = fake12();
    const { ex, runs } = make(ouvreSurAgent, { agentSessions: store, enqueueAgentTurn });
    await ex.startFromNode('t1', 'wf1', ouvreSurAgent, { waId: '33600', contactId: 'c1' }, 'a');
    expect(runs.run?.id).toBe('r1'); // l'id que FakeRuns.start attribue
    expect(ouvertures[0]).toMatchObject({ runId: 'r1' });
    expect(jobs[0]?.runId).toBe('r1');
  });

  it('non-régression : un scénario ouvrant par un message rapide reste refusé hors fenêtre', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const g: WorkflowGraph = { nodes: [n('q', 'quick_message', { body: 'coucou' })], edges: [] };
    const { ex } = make(g);
    const out = await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(typeof out).toBe('string');
    expect(String(out)).toContain('message rapide');
    spy.mockRestore();
  });
});

/**
 * 🔴 LE MONTAGE CENTRAL DU PRODUIT, trouvé en revue de la tâche 12 : « template de campagne, puis l'agent
 * reprend la main sur la réponse ». C'est une TRANSITION FRAÎCHE vers le bloc agent, à ne pas confondre avec
 * le cas où le run est DÉJÀ sur le bloc (le contact répond pendant la conversation, tâche 10).
 *
 * Sans traitement, `walkResolved` rendait `agent_turn`, `restToState` posait le run en attente sur le bloc
 * agent SANS session et SANS tour : l'agent restait MUET, et l'anomalie n'était découverte qu'au message
 * suivant du contact, escaladée en inbox. Un silence, pour un montage parfaitement valide.
 */
describe('advance : transition FRAÎCHE vers un bloc agent (revue tâche 12)', () => {
  const SESSION13 = { id: 's13', tenantId: 't1', runId: 'r1', agentId: 'ag1', nodeId: 'a', waId: '33600', tours: 0, appelsOutils: 0, coutMicroEur: 0, status: 'en_cours' as const };

  // template -> agent : le contact répond au template, le parcours atteint l'agent pour la PREMIÈRE fois.
  const templatePuisAgent: WorkflowGraph = {
    nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('a', 'agent', { agentId: 'ag1' })],
    edges: [e('e1', 'tpl', 'a')],
  };

  it('🔴 ouvre la session et enfile un tour : sans ça l agent reste MUET', async () => {
    const ouvertures: unknown[] = [];
    const jobs: AgentTurnJob[] = [];
    const store = {
      byRun: async () => null,
      open: async (input: unknown) => { ouvertures.push(input); return SESSION13; },
    } as unknown as WorkflowExecutorDeps['agentSessions'];
    const { ex, runs } = make(templatePuisAgent, {
      agentSessions: store,
      enqueueAgentTurn: async (j: AgentTurnJob) => { jobs.push(j); },
    });
    // le run attend sur le TEMPLATE, pas sur l'agent : c'est la réponse du contact qui l'y amène
    runs.run = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'tpl', status: 'waiting', lastMessageId: null };
    await ex.advance('t1', '33600', 'msg1');
    expect(ouvertures).toHaveLength(1);
    expect(ouvertures[0]).toMatchObject({ tenantId: 't1', runId: 'r1', agentId: 'ag1', nodeId: 'a', waId: '33600' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ nodeId: 'a', sessionId: 's13', runId: 'r1' });
    expect(runs.run).toMatchObject({ currentNode: 'a', status: 'waiting' });
  });
});

/**
 * Tâche 13b : la sortie du bloc agent. Le tour a décidé, le parcours doit reprendre par la branche
 * `sortie:<code>`.
 *
 * Réutilise `advance` avec un handle synthétique, comme le fait déjà le patron RCS. Deux gardes rendent ce
 * marqueur sûr : il n'est produit que par nous (Meta n'envoie que `btn:`, `row:`, `card:`), il n'est pas
 * mesuré comme une réponse du contact, et il n'est PAS intercepté par la branche agent (sans quoi la sortie
 * réenfilerait un tour au lieu de faire avancer le parcours).
 */
describe('sortirDuBlocAgent (tâche 13b)', () => {
  const SESSION_B = { id: 'sB', tenantId: 't1', runId: 'r1', agentId: 'ag1', nodeId: 'a', waId: '33600', tours: 2, appelsOutils: 0, coutMicroEur: 0, status: 'en_cours' as const };

  // agent 'a' --sortie:fini--> quick_message 'b'
  const avecSortie: WorkflowGraph = {
    nodes: [n('a', 'agent', { agentId: 'ag1' }), n('b', 'quick_message', { body: 'merci !' })],
    edges: [eh('e1', 'a', 'b', 'sortie:fini')],
  };

  const surAgent = (runs: { run: WorkflowRunRow | null }) => {
    runs.run = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'a', status: 'waiting', lastMessageId: null };
  };

  const depsB = () => {
    const jobs: AgentTurnJob[] = [];
    return {
      jobs,
      over: {
        agentSessions: { byRun: async () => SESSION_B } as unknown as WorkflowExecutorDeps['agentSessions'],
        enqueueAgentTurn: async (j: AgentTurnJob) => { jobs.push(j); },
      },
    };
  };

  it('🔴 fait AVANCER le parcours par la branche, et ne réenfile PAS un tour', async () => {
    const { jobs, over } = depsB();
    const { ex, runs, calls } = make(avecSortie, over);
    surAgent(runs);
    expect(await ex.sortirDuBlocAgent('t1', '33600', 'sB', 'fini')).toBe(true);
    expect(calls).toEqual(['qm:merci !']); // le bloc d'après a bien parlé
    expect(jobs).toEqual([]); // la branche agent n'a PAS intercepté
  });

  it('la sortie ne s applique pas DEUX fois (le parcours a quitté le bloc agent entre-temps)', async () => {
    // Deux mécanismes se recouvrent ici, et c'est voulu : la garde de type de `sortirDuBlocAgent` (le
    // parcours n'est plus sur le bloc agent au second appel) ET la déduplication `lastMessageId` d'`advance`
    // (l'identifiant synthétique porte la session). Ce test observe le résultat, pas lequel des deux a joué.
    const { over } = depsB();
    const { ex, runs, calls } = make(avecSortie, over);
    surAgent(runs);
    await ex.sortirDuBlocAgent('t1', '33600', 'sB', 'fini');
    await ex.sortirDuBlocAgent('t1', '33600', 'sB', 'fini');
    expect(calls).toEqual(['qm:merci !']); // une seule fois
  });

  it('aucun parcours en attente sur un bloc agent : la sortie ne s applique à rien', async () => {
    const { over } = depsB();
    const { ex, runs, calls } = make(avecSortie, over);
    runs.run = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'b', status: 'waiting', lastMessageId: null };
    expect(await ex.sortirDuBlocAgent('t1', '33600', 'sB', 'fini')).toBe(false);
    expect(calls).toEqual([]);
  });

  it('🔴 une sortie n est PAS mesurée comme une réponse du contact', async () => {
    // Sans la garde, chaque sortie d'agent polluerait Analytics avec un faux clic de bouton.
    const mesures: string[] = [];
    const { over } = depsB();
    const { ex, runs } = make(avecSortie, {
      ...over,
      recordNodeEvent: async (e: { kind: string }) => { mesures.push(e.kind); },
    });
    surAgent(runs);
    await ex.sortirDuBlocAgent('t1', '33600', 'sB', 'fini');
    expect(mesures).not.toContain('reply_button');
    expect(mesures).not.toContain('reply_text');
  });
});

describe('sortie d agent NON câblée (revue 13b)', () => {
  const SESSION_C = { id: 'sC', tenantId: 't1', runId: 'r1', agentId: 'ag1', nodeId: 'a', waId: '33600', tours: 1, appelsOutils: 0, coutMicroEur: 0, status: 'en_cours' as const };

  it('🔴 une sortie sans branche câblée ESCALADE, elle ne rend pas la main en silence', async () => {
    // Même famille qu'un bouton non branché : le scénario a prévu que l'agent sorte par là, il l'a fait, et
    // rien ne l'attend. Rendre la main à l'agent de Meta masquerait le trou de montage, et une sortie
    // d'escalade non câblée enverrait le contact au bot générique au lieu d'alerter un opérateur.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rendus: string[] = [];
    const g: WorkflowGraph = { nodes: [n('a', 'agent', { agentId: 'ag1' })], edges: [] }; // aucune sortie câblée
    const { ex, runs, escalations } = make(g, {
      agentSessions: { byRun: async () => SESSION_C } as unknown as WorkflowExecutorDeps['agentSessions'],
      enqueueAgentTurn: async () => {},
      releaseToMba: async (_t: string, w: string) => { rendus.push(w); },
    });
    runs.run = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'a', status: 'waiting', lastMessageId: null };
    expect(await ex.sortirDuBlocAgent('t1', '33600', 'sC', 'escalade')).toBe(true);
    expect(escalations).toEqual(['33600']); // remontée à un humain
    expect(rendus).toEqual([]); // et PAS rendue à l'agent de Meta
    spy.mockRestore();
  });
});

/**
 * Tâche 16 : `mba_envoyer_bloc` déclenche un bloc du scénario COURANT sans persister de run.
 *
 * 🔴 Le piège majeur est de passer par `startFromNode` : il passe par `runFrom`, qui CRÉE un run dès que le
 * repos n'est pas `done`. On aurait alors deux runs `waiting` pour le même contact, et comme
 * `findWaitingByWaId` ne rend que le plus récent, le run de l'agent deviendrait orphelin POUR TOUJOURS.
 */
describe('envoyerBlocDepuisAgent : walk + apply sans run (tâche 16)', () => {
  const surAgent = (runs: { run: WorkflowRunRow | null }) => {
    runs.run = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'a', status: 'waiting', lastMessageId: null };
  };

  // agent 'a' (le bloc courant) et, à part, un message rapide portant un code public.
  const avecBlocCode: WorkflowGraph = {
    nodes: [
      n('a', 'agent', { agentId: 'ag1' }),
      n('q', 'quick_message', { body: 'voici le catalogue', code: 'nod_t1_BLOC' }),
    ],
    edges: [],
  };

  it('envoie le bloc visé et NE TOUCHE PAS au run : c est tout l intérêt', async () => {
    const { ex, runs, calls } = make(avecBlocCode);
    surAgent(runs);
    const avant = { ...runs.run! };
    const r = await ex.envoyerBlocDepuisAgent('t1', '33600', { runId: 'r1', workflowId: 'wf1', code: 'nod_t1_BLOC' });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['qm:voici le catalogue']);
    // Le run n'a pas bougé : ni second run, ni changement de position. C'est ce qui garde le bloc agent vivant.
    expect(runs.run).toEqual(avant);
  });

  it('code inconnu -> refus rendu au modele, aucun envoi', async () => {
    const { ex, runs, calls } = make(avecBlocCode);
    surAgent(runs);
    const r = await ex.envoyerBlocDepuisAgent('t1', '33600', { runId: 'r1', workflowId: 'wf1', code: 'inventé' });
    expect(r.ok).toBe(false);
    expect(r.raison).toContain('inconnu');
    expect(calls).toEqual([]);
  });

  it('🔴 un bloc qui redonne la main a un AGENT est refuse AVANT tout envoi', async () => {
    // Ouvrir une seconde session sur le même parcours lèverait en 23505 sur l'index unique « une seule
    // session vivante par parcours ». Et le refus doit tomber avant l'envoi : sinon le contact reçoit un
    // message pour une action qui n'a pas eu lieu.
    const g: WorkflowGraph = {
      nodes: [
        n('a', 'agent', { agentId: 'ag1' }),
        n('q', 'quick_message', { body: 'avant', code: 'nod_t1_BOUCLE' }),
        n('a2', 'agent', { agentId: 'ag1' }),
      ],
      edges: [e('e1', 'q', 'a2')],
    };
    const { ex, runs, calls } = make(g);
    surAgent(runs);
    const r = await ex.envoyerBlocDepuisAgent('t1', '33600', { runId: 'r1', workflowId: 'wf1', code: 'nod_t1_BOUCLE' });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]); // AUCUN envoi
  });

  it('🔴 un bloc qui remonte a un humain est refuse, et n escalade PAS par ce chemin', async () => {
    // Basculer le fil ici laisserait notre run planté sur le bloc agent : `advance` sort en premier sur
    // `mayAct`, donc la sortie du bloc deviendrait inopérante. L escalade a son propre outil, qui ordonne
    // clore, sortir, PUIS basculer.
    const g: WorkflowGraph = {
      nodes: [n('a', 'agent', { agentId: 'ag1' }), n('q', 'quick_message', { body: 'avant', code: 'nod_t1_IB' }), n('ib', 'inbox')],
      edges: [e('e1', 'q', 'ib')],
    };
    const { ex, runs, calls, escalations } = make(g);
    surAgent(runs);
    const r = await ex.envoyerBlocDepuisAgent('t1', '33600', { runId: 'r1', workflowId: 'wf1', code: 'nod_t1_IB' });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(escalations).toEqual([]);
  });

  it('🔴 un bloc qui contient une ATTENTE est refuse : sans run, la suite ne partirait jamais', async () => {
    // Trouvé en revue. L'échéance rendue par `walk` n'est écrite nulle part puisqu'on ne persiste aucun run :
    // tout ce qui suit le bloc Attente ne partirait JAMAIS, en silence, alors qu'on aurait répondu « envoyé »
    // au modèle.
    const g: WorkflowGraph = {
      nodes: [
        n('a', 'agent', { agentId: 'ag1' }),
        n('q', 'quick_message', { body: 'avant', code: 'nod_t1_WAIT' }),
        n('w', 'wait', { delay: 1, unit: 'hours' }),
        n('q2', 'quick_message', { body: 'la relance qui ne partirait jamais' }),
      ],
      edges: [e('e1', 'q', 'w'), e('e2', 'w', 'q2')],
    };
    const { ex, runs, calls } = make(g);
    surAgent(runs);
    const r = await ex.envoyerBlocDepuisAgent('t1', '33600', { runId: 'r1', workflowId: 'wf1', code: 'nod_t1_WAIT' });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('un bloc Question À ÉCHÉANCE est refuse : sa branche « pas de reponse » ne partirait jamais', async () => {
    const g: WorkflowGraph = {
      nodes: [
        n('a', 'agent', { agentId: 'ag1' }),
        n('q', 'question', { body: 'un choix ?', buttonLabel: 'Voir', rows: [{ title: 'A' }], timeoutValue: 2, timeoutUnit: 'hours', code: 'nod_t1_QT' }),
      ],
      edges: [],
    };
    const { ex, runs, calls } = make(g);
    surAgent(runs);
    const r = await ex.envoyerBlocDepuisAgent('t1', '33600', { runId: 'r1', workflowId: 'wf1', code: 'nod_t1_QT' });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('🔴 aucun evenement d automation n est publie : l agent tient le fil', async () => {
    // Le drapeau `emitEvents` est celui qu'un refactor retourne sans le voir. Un tag posé par un
    // sous-parcours ne doit pas démarrer une automation pendant que l'agent parle au contact.
    const g: WorkflowGraph = {
      nodes: [n('a', 'agent', { agentId: 'ag1' }), n('t', 'tag', { tag: 'vip', code: 'nod_t1_TAG' })],
      edges: [],
    };
    const emis: string[] = [];
    const { ex, runs, calls } = make(g, { emitTagAdded: async (_t: string, _w: string, tag: string) => { emis.push(tag); } });
    surAgent(runs);
    expect((await ex.envoyerBlocDepuisAgent('t1', '33600', { runId: 'r1', workflowId: 'wf1', code: 'nod_t1_TAG' })).ok).toBe(true);
    expect(calls).toEqual(['tag:vip']); // le tag est bien posé
    expect(emis).toEqual([]); // mais rien n'est publié
  });

  it('un code qui ne porte pas le prefixe « nod_ » est refuse, code vide compris', async () => {
    const g: WorkflowGraph = {
      nodes: [n('a', 'agent', { agentId: 'ag1' }), n('q', 'quick_message', { body: 'sans code' })],
      edges: [],
    };
    const { ex, runs, calls } = make(g);
    surAgent(runs);
    // Sans le préfixe exigé, ce code vide correspondrait au premier bloc dépourvu de code.
    expect((await ex.envoyerBlocDepuisAgent('t1', '33600', { runId: 'r1', workflowId: 'wf1', code: '' })).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('un bloc RCS est refuse : le resoudre enverrait AVANT qu on ait pu refuser', async () => {
    const g: WorkflowGraph = {
      nodes: [n('a', 'agent', { agentId: 'ag1' }), n('r', 'rcs_message', { text: 'coucou', code: 'nod_t1_RCS' })],
      edges: [],
    };
    const { ex, runs, calls } = make(g);
    surAgent(runs);
    const r = await ex.envoyerBlocDepuisAgent('t1', '33600', { runId: 'r1', workflowId: 'wf1', code: 'nod_t1_RCS' });
    expect(r.ok).toBe(false);
    expect(r.raison).toContain('RCS');
    expect(calls).toEqual([]);
  });

  it('refuse si le parcours n attend pas sur un bloc agent, ou si le run ou le scenario ne sont pas ceux de l appelant', async () => {
    const { ex, runs, calls } = make(avecBlocCode);
    runs.run = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'q', status: 'waiting', lastMessageId: null };
    expect((await ex.envoyerBlocDepuisAgent('t1', '33600', { runId: 'r1', workflowId: 'wf1', code: 'nod_t1_BLOC' })).ok).toBe(false);

    surAgent(runs);
    expect((await ex.envoyerBlocDepuisAgent('t1', '33600', { runId: 'r_autre', workflowId: 'wf1', code: 'nod_t1_BLOC' })).ok).toBe(false);
    expect((await ex.envoyerBlocDepuisAgent('t1', '33600', { runId: 'r1', workflowId: 'wf_autre', code: 'nod_t1_BLOC' })).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('refuse si le fil est tenu par quelqu un d autre (mayAct)', async () => {
    const { ex, runs, calls } = make(avecBlocCode, { mayAct: async () => false });
    surAgent(runs);
    const r = await ex.envoyerBlocDepuisAgent('t1', '33600', { runId: 'r1', workflowId: 'wf1', code: 'nod_t1_BLOC' });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

/**
 * Tâche 17 : la reprise d'un bloc agent sur échéance d'inactivité.
 *
 * Rien de neuf dans le mécanisme : `resume` sait déjà sortir par le handle `timeout` quand le repos qui a
 * expiré était un `waiting`. Ce qui est neuf, c'est qu'une SESSION est en jeu, et qu'elle doit se clore.
 */
describe('resume : échéance d inactivité sur un bloc agent (tâche 17)', () => {
  const SESSION17 = { id: 's17', tenantId: 't1', runId: 'r1', agentId: 'ag1', nodeId: 'a', waId: '33600', tours: 3, appelsOutils: 0, coutMicroEur: 0, status: 'en_cours' as const };

  // agent 'a' avec DEUX sorties : une arête LIBRE vers 'libre', et le handle `timeout` vers 'fin'.
  const avecTimeout: WorkflowGraph = {
    nodes: [
      n('a', 'agent', { agentId: 'ag1' }),
      n('libre', 'quick_message', { body: 'la mauvaise branche' }),
      // Un TEMPLATE et non un message rapide : il attend sur lui-meme, ce qui rend la position
      // atteinte observable. Un message rapide sans bouton continue et clot le parcours (lecon de la tache 7).
      n('fin', 'template', { templateName: 'relance', language: 'fr' }),
    ],
    edges: [e('e1', 'a', 'libre'), eh('e2', 'a', 'fin', 'timeout')],
  };

  const fake17 = (over: Partial<WorkflowExecutorDeps> = {}, session: typeof SESSION17 | null = SESSION17) => {
    const clotures: Array<{ id: string; status: string; sortie?: string }> = [];
    const store = {
      byRun: async () => session,
      clore: async (_t: string, id: string, status: string, sortie?: string) => { clotures.push({ id, status, ...(sortie ? { sortie } : {}) }); },
    } as unknown as WorkflowExecutorDeps['agentSessions'];
    return { clotures, over: { agentSessions: store, isWindowOpen: async () => true, ...over } };
  };

  const runEnAttente = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'a', status: 'waiting' as const };

  it('🔴 sort par le handle « timeout », JAMAIS par l arête libre', async () => {
    // Le « successeur » d'un bloc agent n'a aucun sens : c'est la réponse qui décide de la suite. Prendre la
    // première arête venue enverrait un contact silencieux dans la branche du premier câblage.
    const { over } = fake17();
    const { ex, runs, calls } = make(avecTimeout, over);
    runs.run = { ...runEnAttente, lastMessageId: null };
    expect(await ex.resume(runEnAttente)).toBe(true);
    expect(calls).toEqual(['tpl:relance']);
    expect(runs.run).toMatchObject({ currentNode: 'fin' });
  });

  it('🔴 clôt la session en « inactivite » : sinon elle reste vivante et orpheline POUR TOUJOURS', async () => {
    // Rien ne ramasse une session `en_cours`. Pire, l'index partiel « une seule session vivante par
    // parcours » la ferait RÉUTILISER si le scénario repasse sur un bloc agent, avec ses tours et son coût
    // déjà consommés : l'agent serait muet dès le premier tour.
    const { clotures, over } = fake17();
    const { ex } = make(avecTimeout, over);
    await ex.resume(runEnAttente);
    expect(clotures).toEqual([{ id: 's17', status: 'inactivite', sortie: 'timeout' }]);
  });

  it('sortie « timeout » NON câblée : le parcours se clôt, la session est close, et la main est rendue', async () => {
    const seul: WorkflowGraph = { nodes: [n('a', 'agent', { agentId: 'ag1' })], edges: [] };
    const rendus: string[] = [];
    const { clotures, over } = fake17({
      releaseToMba: async (_t: string, w: string) => { rendus.push(w); },
      mbaActifPour: async () => true,
    });
    const { ex, runs } = make(seul, over);
    runs.run = { ...runEnAttente, lastMessageId: null };
    expect(await ex.resume(runEnAttente)).toBe(false);
    expect(runs.run).toMatchObject({ currentNode: null, status: 'done' });
    expect(clotures).toEqual([{ id: 's17', status: 'inactivite', sortie: 'timeout' }]);
    expect(rendus).toEqual(['33600']); // l'agent retenait le fil, il faut le rendre
  });

  it('🔴 fil repris par un humain à l échéance : le run meurt ET la session est close', async () => {
    // Le cas le PLUS probable, trouvé en revue : c'est justement la reprise par un opérateur qui fait taire
    // le contact, donc qui déclenche l'échéance. Avant la tâche 17 ce chemin était inatteignable (un run sur
    // un bloc agent n'avait pas de `resume_at`, donc le balayeur ne le voyait pas) : la tâche l'ouvre, et
    // sans clôture la session restait vivante pour toujours.
    const { clotures, over } = fake17({ mayAct: async () => false });
    const { ex, runs } = make(avecTimeout, over);
    runs.run = { ...runEnAttente, lastMessageId: null };
    expect(await ex.resume(runEnAttente)).toBe(false);
    expect(runs.run).toMatchObject({ currentNode: null, status: 'done' });
    // `erreur` et non `inactivite` : le parcours meurt pour une raison qui n'a rien à voir avec le silence.
    expect(clotures).toEqual([{ id: 's17', status: 'erreur' }]);
  });

  it('🔴 scénario supprimé sous les pieds du parcours : le run meurt ET la session est close', async () => {
    const { clotures, over } = fake17();
    const { ex } = make(avecTimeout, { ...over, getGraph: async () => null });
    expect(await ex.resume(runEnAttente)).toBe(false);
    expect(clotures).toEqual([{ id: 's17', status: 'erreur' }]);
  });

  it('un réveil de bloc ATTENTE ne touche à aucune session (statut sleeping, pas waiting)', async () => {
    // Garde de non-régression : la clôture ne doit se déclencher que sur une échéance, pas sur tout réveil.
    const g: WorkflowGraph = {
      nodes: [n('w', 'wait', { delay: 1, unit: 'hours' }), n('q', 'quick_message', { body: 'apres' })],
      edges: [e('e1', 'w', 'q')],
    };
    const { clotures, over } = fake17();
    const { ex } = make(g, over);
    await ex.resume({ id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'w', status: 'sleeping' });
    expect(clotures).toEqual([]);
  });

  it('une échéance sur un bloc QUESTION ne clôt rien : ce run n a pas de session vivante', async () => {
    const g: WorkflowGraph = {
      nodes: [
        n('q', 'question', { body: 'un choix ?', buttonLabel: 'Voir', rows: [{ title: 'A' }] }),
        n('fin', 'quick_message', { body: 'pas de reponse' }),
      ],
      edges: [eh('e1', 'q', 'fin', 'timeout')],
    };
    // La règle n'est pas « un bloc agent », c'est « ce run a-t-il une session vivante ». Un parcours posé
    // sur une question n'en a pas : `byRun` rend null, et rien n'est clos.
    const { clotures, over } = fake17({}, null);
    const { ex, calls } = make(g, over);
    await ex.resume({ id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'q', status: 'waiting' });
    expect(calls).toEqual(['qm:pas de reponse']);
    expect(clotures).toEqual([]);
  });
});
