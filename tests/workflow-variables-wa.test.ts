import { jamaisDesabonne } from './consentement';
import { describe, it, expect, vi } from 'vitest';
import { WorkflowExecutor, type WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph } from '../src/workflow/graph';

/**
 * LES VARIABLES `{{champ}}` DES MESSAGES WHATSAPP D'UN SCÉNARIO.
 *
 * 🔴 CE QUE CES TESTS RÉPARENT : le bloc Question proposait DÉJÀ un sélecteur « + Variable » à l'écran, et le
 * serveur ne substituait rien. Le contact recevait `Bonjour {{prenom}}` avec ses accolades. Un écran qui
 * propose une fonctionnalité que le serveur n'a pas est pire qu'une fonctionnalité absente : personne ne
 * pense à la tester, et c'est le client final qui la découvre.
 */
/**
 * ⚠️ `startInWindow` ET NON `start` : un message rapide ou une question ne peut OUVRIR une conversation que
 * dans la fenêtre de 24 h, et `start` refuse donc de démarrer un scénario qui commence par là. C'est
 * `startInWindow` qu'emprunte le chemin réel (un contact qui vient d'écrire). Ces tests portent sur la
 * SUBSTITUTION, pas sur cette garde, qui a ses propres tests.
 */
/**
 * ⚠️ LE DERNIER `undefined` DES ASSERTIONS `sendQuickMessage` EST LE BOUTON DE LIEN (`cta_url`), pas une
 * coquille : le contrat en a SIX paramètres depuis le 2026-09-11, et `toHaveBeenCalledWith` compare la
 * longueur de la liste d'arguments. L'écrire vaut mieux que de relâcher l'assertion en `expect.anything()`,
 * qui laisserait passer un lien transmis à tort sur un bloc qui n'en porte pas.
 */
const graphe = (type: 'quick_message' | 'question', data: Record<string, unknown>): WorkflowGraph => ({
  nodes: [{ id: 'n', type, data, position: { x: 0, y: 0 } }],
  edges: [],
});

class FakeRuns {
  async closeActiveByWaId(): Promise<string[]> { return []; }
  async start(): Promise<{ id: string }> { return { id: 'r1' }; }
  async setState(): Promise<void> {}
}

function deps(over: Partial<WorkflowExecutorDeps>): WorkflowExecutorDeps {
  return {
    estDesabonne: jamaisDesabonne,
    runs: new FakeRuns() as unknown as WorkflowExecutorDeps['runs'],
    getGraph: async () => graphe('quick_message', {}),
    applyTag: async () => {},
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async () => {},
    sendQuickMessage: async () => {},
    sendFlow: async () => {},
    sendQuestion: async () => {},
    ...over,
  };
}

describe('variables des messages WhatsApp', () => {
  it('🔴 un MESSAGE RAPIDE résout les variables du contact', async () => {
    const sendQuickMessage = vi.fn().mockResolvedValue(undefined);
    const varsFor = vi.fn().mockResolvedValue({ prenom: 'Camille' });
    const ex = new WorkflowExecutor(deps({ sendQuickMessage, varsFor }));
    await ex.startInWindow('t1', 'wf1', graphe('quick_message', { body: 'Bonjour {{prenom}} !' }), { waId: '336', contactId: null });
    expect(sendQuickMessage).toHaveBeenCalledWith('t1', '336', 'Bonjour Camille !', expect.anything(), undefined, undefined);
  });

  it('🔴 une QUESTION aussi : l’écran le proposait déjà, le serveur ne le faisait pas', async () => {
    const sendQuestion = vi.fn().mockResolvedValue(undefined);
    const varsFor = vi.fn().mockResolvedValue({ prenom: 'Camille' });
    const ex = new WorkflowExecutor(deps({ sendQuestion, varsFor }));
    await ex.startInWindow('t1', 'wf1', graphe('question', {
      body: 'Bonjour {{prenom}}, que voulez-vous ?', buttonLabel: 'Choisir',
      rows: [{ title: 'Un devis' }],
    }), { waId: '336', contactId: null });
    expect(sendQuestion).toHaveBeenCalledWith('t1', '336', 'Bonjour Camille, que voulez-vous ?', 'Choisir', expect.anything());
  });

  it('⚠️ une variable INCONNUE devient du vide, jamais ses accolades', async () => {
    // Même contrat que les modèles d'e-mail et le RCS (`renderText`) : une valeur absente s'efface. Laisser
    // les accolades ferait partir un message qui parle de lui-même au contact.
    const sendQuickMessage = vi.fn().mockResolvedValue(undefined);
    const ex = new WorkflowExecutor(deps({ sendQuickMessage, varsFor: async () => ({}) }));
    await ex.startInWindow('t1', 'wf1', graphe('quick_message', { body: 'Bonjour {{inconnu}}.' }), { waId: '336', contactId: null });
    expect(sendQuickMessage).toHaveBeenCalledWith('t1', '336', 'Bonjour .', expect.anything(), undefined, undefined);
  });

  it('🔴 un message SANS variable ne lit PAS la fiche du contact', async () => {
    // La lecture coûte une requête par message envoyé. Le cas courant (aucune accolade) ne doit rien payer :
    // c'est la même optimisation que le chemin RCS.
    const varsFor = vi.fn().mockResolvedValue({});
    const ex = new WorkflowExecutor(deps({ sendQuickMessage: async () => {}, varsFor }));
    await ex.startInWindow('t1', 'wf1', graphe('quick_message', { body: 'Bonjour !' }), { waId: '336', contactId: null });
    expect(varsFor).not.toHaveBeenCalled();
  });

  it('⚠️ sans table de variables câblée, le message part TEL QUEL plutôt que de ne pas partir', async () => {
    const sendQuickMessage = vi.fn().mockResolvedValue(undefined);
    const ex = new WorkflowExecutor(deps({ sendQuickMessage }));
    await ex.startInWindow('t1', 'wf1', graphe('quick_message', { body: 'Bonjour {{prenom}}' }), { waId: '336', contactId: null });
    expect(sendQuickMessage).toHaveBeenCalledWith('t1', '336', 'Bonjour {{prenom}}', expect.anything(), undefined, undefined);
  });
});
