import { describe, it, expect } from 'vitest';
import { parseGraph, isWorkflowNodeType } from '../src/workflow/graph';
import {
  actionOf, walk, scanOpening, etapeOffreUnChoix, questionRows, questionTimeoutMs,
  waitBeforeSessionMessage, QUESTION_MAX_ROWS, WAIT_MAX_MS,
} from '../src/workflow/engine';
import type { WorkflowGraph, WorkflowNode } from '../src/workflow/graph';

/**
 * Bloc QUESTION : le CONTRAT pur, sans base ni réseau.
 *
 * Ce bloc est le seul du produit à attendre DEUX choses à la fois : une réponse du contact, et le temps qui
 * passe. Ce fichier verrouille la partie décidée par le moteur pur : ce que le bloc envoie, quand il bloque,
 * et ce qu'il pose comme échéance. La reprise réelle (routage, réveil) est dans `workflow-question-exec`.
 */
const q = (id: string, data: Record<string, unknown>): WorkflowNode =>
  ({ id, type: 'question', position: { x: 0, y: 0 }, data });

const graphe = (nodes: WorkflowNode[], edges: WorkflowGraph['edges'] = []): WorkflowGraph => ({ nodes, edges });

describe('bloc Question : le type', () => {
  it('est accepté par le graphe, donc un scénario qui en contient s’enregistre', () => {
    expect(isWorkflowNodeType('question')).toBe(true);
    const g = parseGraph({ nodes: [{ id: 'n1', type: 'question', position: { x: 0, y: 0 }, data: { body: 'Ça va ?' } }], edges: [] });
    expect(g?.nodes[0]?.type).toBe('question');
  });
});

describe('bloc Question : ce qu’il envoie (actionOf)', () => {
  it('🔴 le CORPS fait foi : sans texte, aucune action', () => {
    // Sans question écrite il n'y a rien à envoyer, donc rien à attendre. C'est ce `null` qui rend le bloc
    // passe-plat dans `walk` au lieu de figer le parcours sur une question jamais posée.
    expect(actionOf(q('n1', {}))).toBeNull();
    expect(actionOf(q('n1', { body: '   ' }))).toBeNull();
    expect(actionOf(q('n1', { body: '', rows: [{ title: 'Oui' }] }))).toBeNull();
  });

  it('rend une question AVEC menu', () => {
    const a = actionOf(q('n1', { body: 'Quelle taille ?', buttonLabel: 'Voir', rows: [{ title: 'S' }, { title: 'M', description: 'le plus courant' }] }));
    expect(a).toEqual({
      kind: 'sendQuestion', body: 'Quelle taille ?', buttonLabel: 'Voir',
      rows: [{ title: 'S' }, { title: 'M', description: 'le plus courant' }],
    });
  });

  it('rend une question SANS menu : elle attend une réponse écrite', () => {
    const a = actionOf(q('n1', { body: 'Quel est ton code postal ?' }));
    expect(a).toMatchObject({ kind: 'sendQuestion', body: 'Quel est ton code postal ?', rows: [] });
  });

  it('libellé de bouton absent -> repli « Choisir » (Meta l’EXIGE dès qu’il y a une liste)', () => {
    expect(actionOf(q('n1', { body: 'Q', rows: [{ title: 'A' }] }))).toMatchObject({ buttonLabel: 'Choisir' });
    expect(actionOf(q('n1', { body: 'Q', buttonLabel: '   ', rows: [{ title: 'A' }] }))).toMatchObject({ buttonLabel: 'Choisir' });
  });

  it('🔴 les lignes VIDES sont conservées : leur index EST la sortie du scénario', () => {
    // Filtrer ici renumérotrait les lignes suivantes, et « Non » partirait sur la branche de « Oui ».
    // Le filtrage se fait à l'ENVOI, en préservant l'index (`MetaClient.sendList`).
    const a = actionOf(q('n1', { body: 'Q', rows: [{ title: 'Oui' }, { title: '' }, { title: 'Non' }] }));
    expect(a).toMatchObject({ rows: [{ title: 'Oui' }, { title: '' }, { title: 'Non' }] });
  });
});

describe('bloc Question : lecture défensive des lignes', () => {
  it('une forme inattendue ne fait pas tomber la lecture', () => {
    expect(questionRows(q('n1', {}))).toEqual([]);
    expect(questionRows(q('n1', { rows: 'oui' }))).toEqual([]);
    expect(questionRows(q('n1', { rows: [null, 42, { title: 'Bon' }] }))).toEqual([{ title: '' }, { title: '' }, { title: 'Bon' }]);
  });

  it('borne à 10 lignes, 24 caractères de titre, 72 de description (limites WhatsApp)', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ title: `r${i}` }));
    expect(questionRows(q('n1', { rows })).length).toBe(QUESTION_MAX_ROWS);
    const long = questionRows(q('n1', { rows: [{ title: 'a'.repeat(50), description: 'b'.repeat(200) }] }))[0]!;
    expect(long.title.length).toBe(24);
    expect(long.description?.length).toBe(72);
  });
});

describe('bloc Question : l’échéance « pas de réponse »', () => {
  it('0, absent, négatif ou unité inconnue -> aucune échéance', () => {
    expect(questionTimeoutMs(q('n1', {}))).toBe(0);
    expect(questionTimeoutMs(q('n1', { timeoutValue: 0 }))).toBe(0);
    expect(questionTimeoutMs(q('n1', { timeoutValue: -3, timeoutUnit: 'hours' }))).toBe(0);
    expect(questionTimeoutMs(q('n1', { timeoutValue: 2, timeoutUnit: 'siecles' }))).toBe(0);
  });

  it('mêmes unités et même plafond que le bloc Attente', () => {
    expect(questionTimeoutMs(q('n1', { timeoutValue: 30, timeoutUnit: 'minutes' }))).toBe(30 * 60_000);
    expect(questionTimeoutMs(q('n1', { timeoutValue: 2 }))).toBe(2 * 3_600_000); // défaut = heures
    expect(questionTimeoutMs(q('n1', { timeoutValue: 999, timeoutUnit: 'days' }))).toBe(WAIT_MAX_MS);
  });
});

describe('bloc Question : il attend TOUJOURS', () => {
  it('🔴 même SANS menu il offre un choix, donc il bloque et garde la main', () => {
    // Le faire dépendre du menu rendrait une question ouverte non bloquante : le bloc suivant partirait
    // aussitôt et la réponse du contact ne serait jamais lue.
    expect(etapeOffreUnChoix(actionOf(q('n1', { body: 'Ton prénom ?' })))).toBe(true);
    expect(etapeOffreUnChoix(actionOf(q('n1', { body: 'Q', rows: [{ title: 'A' }] })))).toBe(true);
  });

  it('le walk s’arrête sur la question, et porte l’échéance quand il y en a une', () => {
    const g = graphe([q('n1', { body: 'Q', rows: [{ title: 'A' }], timeoutValue: 30, timeoutUnit: 'minutes' })]);
    const r = walk(g, 'n1');
    expect(r.actions.map((a) => a.action.kind)).toEqual(['sendQuestion']);
    expect(r.rest).toEqual({ status: 'waiting', nodeId: 'n1', timeoutInMs: 30 * 60_000 });
  });

  it('sans délai, il attend sans limite (aucune échéance dans le repos)', () => {
    const r = walk(graphe([q('n1', { body: 'Q' })]), 'n1');
    expect(r.rest).toEqual({ status: 'waiting', nodeId: 'n1' });
  });

  it('🔴 question NON configurée -> passe-plat, jamais un parcours figé pour toujours', () => {
    // Attendre la réponse à une question jamais posée gèlerait le parcours sans le moindre signal. Divergence
    // ASSUMÉE avec `quick_message`, qui bloque même vide : ici on choisit le comportement qui se voit.
    const g = graphe(
      [q('n1', {}), { id: 'n2', type: 'tag', position: { x: 0, y: 0 }, data: { tag: 'vu' } }],
      [{ id: 'e1', source: 'n1', target: 'n2' }],
    );
    const r = walk(g, 'n1');
    expect(r.actions.map((a) => a.action.kind)).toEqual(['tag']);
    expect(r.rest.status).toBe('done');
  });
});

describe('bloc Question : ce qu’en pense l’analyse d’ouverture', () => {
  it('🔴 une question CONFIGURÉE ouvre une SESSION : elle ne peut pas ouvrir une campagne', () => {
    const scan = scanOpening(graphe([q('n1', { body: 'Q', rows: [{ title: 'A' }] })]));
    expect(scan.sessionOpen).toBe(true);
    expect(scan.firstTemplate).toBeNull();
  });

  it('non configurée, elle est TRAVERSÉE : l’analyse voit le même parcours que le moteur', () => {
    const g = graphe(
      [q('n1', {}), { id: 'n2', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } }],
      [{ id: 'e1', source: 'n1', target: 'n2' }],
    );
    const scan = scanOpening(g);
    expect(scan.sessionOpen).toBe(false);
    expect(scan.firstTemplate?.id).toBe('n2');
  });

  it('🔴 attente de 24 h PUIS question : montage signalé, la question ne partirait jamais', () => {
    const g = graphe(
      [
        { id: 'w', type: 'wait', position: { x: 0, y: 0 }, data: { delay: 2, unit: 'days' } },
        q('n1', { body: 'Q' }),
      ],
      [{ id: 'e1', source: 'w', target: 'n1' }],
    );
    expect(waitBeforeSessionMessage(g)).toEqual({ waitNodeId: 'w', messageNodeId: 'n1' });
  });

  it('une attente COURTE ne signale rien : la fenêtre peut encore être ouverte', () => {
    const g = graphe(
      [
        { id: 'w', type: 'wait', position: { x: 0, y: 0 }, data: { delay: 10, unit: 'minutes' } },
        q('n1', { body: 'Q' }),
      ],
      [{ id: 'e1', source: 'w', target: 'n1' }],
    );
    expect(waitBeforeSessionMessage(g)).toBeNull();
  });
});
