import { describe, it, expect } from 'vitest';
import { walk, waitDurationMs, WAIT_MAX_MS, scanOpening, waitBeforeSessionMessage } from '../src/workflow/engine';
import { runWorkflowWakeSweep } from '../src/workflow/wake-sweep';
import type { DueRun } from '../src/workflow/wake-sweep';
import type { WorkflowGraph, WorkflowNode } from '../src/workflow/graph';

const nd = (id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode =>
  ({ id, type: type as WorkflowNode['type'], position: { x: 0, y: 0 }, data });
const ed = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });
const g = (nodes: WorkflowNode[], edges: WorkflowGraph['edges'] = []): WorkflowGraph => ({ nodes, edges });

describe('waitDurationMs (bloc Attente, fonction pure)', () => {
  it('convertit chaque unité', () => {
    expect(waitDurationMs(nd('w', 'wait', { delay: 5, unit: 'minutes' }))).toBe(5 * 60_000);
    expect(waitDurationMs(nd('w', 'wait', { delay: 2, unit: 'hours' }))).toBe(2 * 3_600_000);
    expect(waitDurationMs(nd('w', 'wait', { delay: 3, unit: 'days' }))).toBe(3 * 86_400_000);
  });

  it('unité absente -> heures (le défaut du formulaire)', () => {
    expect(waitDurationMs(nd('w', 'wait', { delay: 1 }))).toBe(3_600_000);
  });

  it('durée absente, nulle, négative ou non numérique -> 0 (bloc non configuré)', () => {
    for (const data of [{}, { delay: 0 }, { delay: -3 }, { delay: 'plus tard' }, { delay: 2, unit: 'siecles' }]) {
      expect(waitDurationMs(nd('w', 'wait', data))).toBe(0);
    }
  });

  it('borné à 30 jours : une saisie absurde ne pose pas une échéance dans 10 ans', () => {
    expect(waitDurationMs(nd('w', 'wait', { delay: 9999, unit: 'days' }))).toBe(WAIT_MAX_MS);
  });
});

describe('walk : un bloc Attente endort le parcours', () => {
  it('les actions AVANT l’attente partent, et le parcours dort sur le bloc Attente', () => {
    const graph = g(
      [nd('t', 'tag', { tag: 'vip' }), nd('w', 'wait', { delay: 2, unit: 'hours' }), nd('t2', 'template', { templateName: 'promo' })],
      [ed('t', 'w'), ed('w', 't2')],
    );
    const r = walk(graph, 't');
    expect(r.actions.map((e) => e.action)).toEqual([{ kind: 'tag', tag: 'vip' }]);
    expect(r.rest).toEqual({ status: 'sleeping', nodeId: 'w', resumeInMs: 2 * 3_600_000 });
  });

  it('durée NON configurée -> passe-plat : on ne bloque pas un parcours sur une saisie oubliée', () => {
    const graph = g(
      [nd('w', 'wait', {}), nd('t', 'template', { templateName: 'promo' })],
      [ed('w', 't')],
    );
    const r = walk(graph, 'w');
    expect(r.rest.status).toBe('waiting'); // arrivé au template, pas endormi
    expect(r.actions.map((e) => e.action.kind)).toEqual(['sendTemplate']);
  });

  it('attente en fin de chaîne -> dort quand même (le réveil clôturera le run)', () => {
    const r = walk(g([nd('w', 'wait', { delay: 1, unit: 'days' })]), 'w');
    expect(r.rest.status).toBe('sleeping');
  });

  it('une attente APRÈS un template n’est pas atteinte par le walk d’ouverture (le template bloque avant)', () => {
    const graph = g([nd('t', 'template', { templateName: 'p' }), nd('w', 'wait', { delay: 1, unit: 'hours' })], [ed('t', 'w')]);
    expect(walk(graph, 't').rest).toEqual({ status: 'waiting', nodeId: 't' });
    expect(scanOpening(graph).waitBeforeTemplate).toBe(false);
  });
});

describe('runWorkflowWakeSweep', () => {
  const run = (id: string): DueRun => ({ id, workflowId: 'wf', tenantId: 't1', waId: '33600', currentNode: 'w' });

  it('reprend chaque parcours réservé et compte les reprises effectives', async () => {
    const repris: string[] = [];
    const n = await runWorkflowWakeSweep({
      claimDue: async () => [run('a'), run('b')],
      resume: async (r) => { repris.push(r.id); return true; },
    });
    expect(n).toBe(2);
    expect(repris).toEqual(['a', 'b']);
  });

  it('une reprise REFUSÉE n’est pas comptée (fil repris par un humain, fenêtre fermée…)', async () => {
    const n = await runWorkflowWakeSweep({
      claimDue: async () => [run('a'), run('b')],
      resume: async (r) => r.id === 'a',
    });
    expect(n).toBe(1);
  });

  it('un parcours qui THROW n’interrompt pas le balayage des suivants', async () => {
    const vus: string[] = [];
    const n = await runWorkflowWakeSweep({
      claimDue: async () => [run('a'), run('b'), run('c')],
      resume: async (r) => { vus.push(r.id); if (r.id === 'b') throw new Error('réseau'); return true; },
    });
    expect(vus).toEqual(['a', 'b', 'c']);
    expect(n).toBe(2);
  });

  it('la RÉSERVATION précède toute reprise : rien n’est repris sans avoir été claimé', async () => {
    // Garantie anti-doublon : c'est le claim (atomique en base) qui interdit à deux workers de réveiller le
    // même parcours. Si un jour on inversait l'ordre, deux workers enverraient le même message.
    const ordre: string[] = [];
    await runWorkflowWakeSweep({
      claimDue: async () => { ordre.push('claim'); return [run('a')]; },
      resume: async () => { ordre.push('resume'); return true; },
    });
    expect(ordre).toEqual(['claim', 'resume']);
  });

  it('aucun parcours dû -> aucun appel de reprise', async () => {
    let appels = 0;
    const n = await runWorkflowWakeSweep({ claimDue: async () => [], resume: async () => { appels += 1; return true; } });
    expect(n).toBe(0);
    expect(appels).toBe(0);
  });
});

describe('waitBeforeSessionMessage (montage impossible, détecté pour l’UI)', () => {
  const QM = (id: string) => nd(id, 'quick_message', { body: 'Alors ?', quickReplies: ['Oui'] });

  it('attente de 24 h ou plus PUIS message rapide -> signalé, avec les deux blocs', () => {
    const graph = g([nd('w', 'wait', { delay: 2, unit: 'days' }), QM('q')], [ed('w', 'q')]);
    expect(waitBeforeSessionMessage(graph)).toEqual({ waitNodeId: 'w', messageNodeId: 'q' });
  });

  it('attente CUMULÉE qui franchit 24 h (12 h + 13 h) -> signalé', () => {
    const graph = g(
      [nd('w1', 'wait', { delay: 12, unit: 'hours' }), nd('w2', 'wait', { delay: 13, unit: 'hours' }), QM('q')],
      [ed('w1', 'w2'), ed('w2', 'q')],
    );
    expect(waitBeforeSessionMessage(graph)?.messageNodeId).toBe('q');
  });

  it('un message SANS bouton est TRAVERSÉ : le montage fautif d’après est quand même signalé', () => {
    // Un message rapide sans bouton ne bloque plus le parcours (cf. `walk`). L'analyse doit donc aller
    // au-delà, sinon « 12 h, message sans bouton, 13 h, message rapide » passerait pour sain alors que son
    // dernier message ne partira jamais : la fenêtre est fermée à coup sûr après 25 h cumulées.
    const graph = g(
      [nd('w1', 'wait', { delay: 12, unit: 'hours' }), nd('qm', 'quick_message', { body: 'un mot' }),
       nd('w2', 'wait', { delay: 13, unit: 'hours' }), QM('q')],
      [ed('w1', 'qm'), ed('qm', 'w2'), ed('w2', 'q')],
    );
    expect(waitBeforeSessionMessage(graph)).toEqual({ waitNodeId: 'w2', messageNodeId: 'q' });
  });

  it('un message rapide AVEC bouton arrête l’analyse (il attend vraiment une réponse, qui rouvrira la fenêtre)', () => {
    const graph = g(
      [nd('w1', 'wait', { delay: 12, unit: 'hours' }), QM('bloquant'),
       nd('w2', 'wait', { delay: 13, unit: 'hours' }), QM('q')],
      [ed('w1', 'bloquant'), ed('bloquant', 'w2'), ed('w2', 'q')],
    );
    // Seul le 1er message compte, et 12 h ne suffisent pas : rien à signaler.
    expect(waitBeforeSessionMessage(graph)).toBeNull();
  });

  it('attente COURTE puis message rapide -> RIEN (la fenêtre peut être encore ouverte, c’est au runtime de voir)', () => {
    const graph = g([nd('w', 'wait', { delay: 2, unit: 'hours' }), QM('q')], [ed('w', 'q')]);
    expect(waitBeforeSessionMessage(graph)).toBeNull();
  });

  it('un TEMPLATE entre l’attente et le message remet le compteur à zéro (le parcours attend la RÉPONSE, qui rouvre la fenêtre)', () => {
    const graph = g(
      [nd('w', 'wait', { delay: 3, unit: 'days' }), nd('t', 'template', { templateName: 'promo' }), QM('q')],
      [ed('w', 't'), ed('t', 'q')],
    );
    expect(waitBeforeSessionMessage(graph)).toBeNull();
  });

  it('longue attente puis TEMPLATE -> rien (un template part hors fenêtre, c’est son intérêt)', () => {
    const graph = g([nd('w', 'wait', { delay: 5, unit: 'days' }), nd('t', 'template', { templateName: 'p' })], [ed('w', 't')]);
    expect(waitBeforeSessionMessage(graph)).toBeNull();
  });

  it('message rapide NON configuré après une longue attente -> rien (il n’envoie rien)', () => {
    const graph = g([nd('w', 'wait', { delay: 2, unit: 'days' }), nd('q', 'quick_message', {})], [ed('w', 'q')]);
    expect(waitBeforeSessionMessage(graph)).toBeNull();
  });

  it('détecte le montage sur UNE branche de condition seulement', () => {
    const graph = g(
      [nd('w', 'wait', { delay: 2, unit: 'days' }), nd('c', 'condition', {}), nd('t', 'template', { templateName: 'p' }), QM('q')],
      [ed('w', 'c'), { id: 'a', source: 'c', target: 't', sourceHandle: 'true' }, { id: 'b', source: 'c', target: 'q', sourceHandle: 'false' }],
    );
    expect(waitBeforeSessionMessage(graph)?.messageNodeId).toBe('q');
  });

  it('CYCLE d’attentes : la fonction termine (elle ne boucle pas à l’infini)', () => {
    const graph = g(
      [nd('w1', 'wait', { delay: 1, unit: 'hours' }), nd('w2', 'wait', { delay: 1, unit: 'hours' })],
      [ed('w1', 'w2'), ed('w2', 'w1')],
    );
    expect(waitBeforeSessionMessage(graph)).toBeNull(); // aucun message de session sur ce cycle
  });

  it('graphe sans attente -> rien', () => {
    expect(waitBeforeSessionMessage(g([QM('q')]))).toBeNull();
  });
});

describe('runWorkflowWakeSweep : nettoyage des parcours dormants trop vieux', () => {
  const run = (id: string): DueRun => ({ id, workflowId: 'wf', tenantId: 't1', waId: '33600', currentNode: 'w' });

  it('clôt les vieux AVANT de réveiller les dus', async () => {
    const ordre: string[] = [];
    await runWorkflowWakeSweep({
      closeStale: async () => { ordre.push('close'); return 2; },
      claimDue: async () => { ordre.push('claim'); return [run('a')]; },
      resume: async () => { ordre.push('resume'); return true; },
    });
    expect(ordre).toEqual(['close', 'claim', 'resume']);
  });

  it('un nettoyage en échec n’empêche PAS les réveils légitimes', async () => {
    const n = await runWorkflowWakeSweep({
      closeStale: async () => { throw new Error('base indisponible'); },
      claimDue: async () => [run('a')],
      resume: async () => true,
    });
    expect(n).toBe(1);
  });
});
