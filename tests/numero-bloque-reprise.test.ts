import { describe, it, expect } from 'vitest';
import { jamaisDesabonne } from './consentement';
import { avecGardesDEtatInertes, depsInertes } from './executeur-inerte';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';
import type { WorkflowRunRow, RunState } from '../src/workflow/run-store.pg';
import { NumeroSuspenduError } from '../src/meta/numero-delie';

/**
 * 🔴 LE PARCOURS QUI REPREND SUR UN NUMÉRO BLOQUÉ (relecture du lot 4, livraison A, 2026-10-06), avec le VRAI
 * `WorkflowExecutor`.
 *
 * Seul le démarrage (`runFrom`) vérifiait le numéro avant tout effet. Une REPRISE (réveil d'une attente, réponse du
 * contact, bloc poussé par un agent) faisait ses effets puis butait sur l'envoi WhatsApp : l'exception sortait,
 * rien n'était écrit, et le bail de 15 minutes (ou le message suivant du contact) rejouait le tout. Sur un numéro
 * suspendu, qui le reste au moins 7 jours et garde ses entrants, un scénario « attente, e-mail, modèle » envoyait
 * un e-mail tous les quarts d'heure, et un « appel HTTP » créait un lead à chaque reprise.
 */

const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const EMAIL = { emailAccountId: 'a1', templateId: 't1', to: { kind: 'literal', value: 'client@exemple.fr' } };

/** « Attente, e-mail, modèle WhatsApp » : le scénario du défaut. */
const ATTENTE_EMAIL_MODELE: WorkflowGraph = {
  nodes: [n('w', 'wait', { delay: 1, unit: 'days' }), n('em', 'email', EMAIL), n('tpl', 'template', { templateName: 'rappel' })],
  edges: [{ id: 'e1', source: 'w', target: 'em' }, { id: 'e2', source: 'em', target: 'tpl' }],
};
/** « Attente, e-mail, étiquette » : SANS WhatsApp, il doit continuer de tourner sur un numéro bloqué. */
const ATTENTE_EMAIL_TAG: WorkflowGraph = {
  nodes: [n('w', 'wait', { delay: 1, unit: 'days' }), n('em', 'email', EMAIL), n('tg', 'tag', { tag: 'relance' })],
  edges: [{ id: 'e1', source: 'w', target: 'em' }, { id: 'e2', source: 'em', target: 'tg' }],
};

const RUN: WorkflowRunRow = {
  id: 'run-1', workflowId: 'wf1', tenantId: 't1', waId: '33611', contactId: 'c1',
  currentNode: 'w', status: 'sleeping', lastMessageId: null, grapheFige: null,
};

/** Le monde : UNE garde (`bloque.vrai`), lue par la vérification préalable et par l'envoi du modèle. */
function monde(graph: WorkflowGraph, run: WorkflowRunRow = RUN) {
  const bloque = { vrai: true };
  const effets: string[] = [];
  const etats: RunState[] = [];
  const garde = (): void => { if (bloque.vrai) throw new NumeroSuspenduError('pn1'); };
  const runs = {
    closeActiveByWaId: async (): Promise<string[]> => [],
    start: async (): Promise<{ id: string }> => ({ id: 'run-2' }),
    findWaitingByWaId: async (): Promise<WorkflowRunRow | null> => ({ ...run, status: 'waiting' }),
    setState: async (_id: string, s: RunState): Promise<void> => { etats.push(s); },
  };
  const deps: WorkflowExecutorDeps = {
    ...depsInertes,
    estDesabonne: jamaisDesabonne,
    runs: avecGardesDEtatInertes(runs),
    getGraph: async () => graph,
    applyTag: async (_t, waId, tag) => { effets.push(`tag ${tag} ${waId}`); },
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async (_t, waId, nom) => { garde(); effets.push(`modèle ${nom} ${waId}`); },
    sendQuickMessage: async (_t, waId) => { garde(); effets.push(`message ${waId}`); },
    sendFlow: async (_t, waId) => { garde(); effets.push(`formulaire ${waId}`); },
    sendQuestion: async (_t, waId) => { garde(); effets.push(`question ${waId}`); },
    sendEmail: async (_t, waId) => { effets.push(`e-mail ${waId}`); },
    verifierNumeroWhatsApp: async () => { garde(); },
  };
  return { executor: new WorkflowExecutor(deps), bloque, effets, etats };
}

const emails = (effets: readonly string[]) => effets.filter((e) => e.startsWith('e-mail'));

describe('🔴 un parcours qui REPREND sur un numéro bloqué ne rejoue rien', () => {
  it('le réveil d’une attente (`resume`) : refusé AVANT l’e-mail, à chaque reprise du bail, puis tout part une fois débloqué', async () => {
    const m = monde(ATTENTE_EMAIL_MODELE);
    for (let i = 0; i < 2; i++) {
      await expect(m.executor.resume(RUN)).rejects.toBeInstanceOf(NumeroSuspenduError);
    }
    expect(emails(m.effets), 'l’e-mail repart à chaque reprise du bail').toEqual([]);
    expect(m.etats, 'aucun état écrit : le parcours reste dû et repart après le paiement').toEqual([]);
    m.bloque.vrai = false;
    expect(await m.executor.resume(RUN)).toBe(true);
    expect(m.effets).toEqual(['e-mail 33611', 'modèle rappel 33611']);
  });

  it('la réponse du contact (`advance`) : refusée AVANT l’e-mail, à chaque message, et le parcours reste sur son bloc', async () => {
    const m = monde(ATTENTE_EMAIL_MODELE);
    await expect(m.executor.advance('t1', '33611', 'wamid.1')).rejects.toBeInstanceOf(NumeroSuspenduError);
    await expect(m.executor.advance('t1', '33611', 'wamid.2')).rejects.toBeInstanceOf(NumeroSuspenduError);
    expect(emails(m.effets), 'l’e-mail repart à chaque message du contact').toEqual([]);
    m.bloque.vrai = false;
    await m.executor.advance('t1', '33611', 'wamid.3');
    expect(m.effets).toEqual(['e-mail 33611', 'modèle rappel 33611']);
  });

  it('le bloc poussé par un agent (`envoyerBlocDepuisAgent`) : refusé AVANT l’e-mail', async () => {
    const graphe: WorkflowGraph = {
      nodes: [n('a', 'agent', { agentId: 'ag1' }), n('em', 'email', { ...EMAIL, code: 'nod_t1_BLOC' }), n('tpl', 'template', { templateName: 'rappel' })],
      edges: [{ id: 'e1', source: 'em', target: 'tpl' }],
    };
    const m = monde(graphe, { ...RUN, currentNode: 'a' });
    // Le graphe fourni est celui du scénario entier (le bloc seul n'est pas en jeu ici) : ce qui compte est l'ordre de
    // la garde du numéro et de l'e-mail.
    const pousser = () => m.executor.envoyerBlocDepuisAgent('t1', '33611', { runId: 'run-1', workflowId: 'wf1', graphe, noeudId: 'em' });
    await expect(pousser()).rejects.toBeInstanceOf(NumeroSuspenduError);
    expect(emails(m.effets), 'l’e-mail part avant le modèle refusé').toEqual([]);
    m.bloque.vrai = false;
    expect(await pousser()).toEqual({ ok: true });
    expect(m.effets).toEqual(['e-mail 33611', 'modèle rappel 33611']);
  });

  it('un parcours SANS WhatsApp continue de tourner sur un numéro bloqué', async () => {
    const m = monde(ATTENTE_EMAIL_TAG);
    expect(await m.executor.resume(RUN)).toBe(true);
    expect(m.effets).toEqual(['e-mail 33611', 'tag relance 33611']);
  });
});
