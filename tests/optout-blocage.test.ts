import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { WorkflowExecutor, EST_UN_ENVOI } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph } from '../src/workflow/graph';

/**
 * UN CONTACT DÉSABONNÉ NE REÇOIT RIEN D'AUTOMATIQUE.
 *
 * 🔴 CE QUE CE FICHIER FERME. Mesuré le 2026-09-13 : `optInAllows` n'était appelée qu'aux deux points de
 * départ des campagnes et de l'API publique. Un SCÉNARIO, une AUTOMATION ou un AGENT IA atteignaient donc
 * quelqu'un qui avait écrit STOP. Les trois passent par le même exécuteur : la garde y est posée une fois.
 *
 * 🔴 ET LE CAS QUI PROTÈGE L'USAGE EST AUSSI IMPORTANT QUE LES AUTRES. Sans lui, un opérateur ne pourrait
 * même plus accuser réception d'un opt-out, ni répondre à une réclamation posée juste après. Bloquer
 * l'humain qui traite la demande de la personne, au nom de cette même demande, serait absurde. La machine
 * se tait ; la personne peut encore répondre à la personne. (Décision de Julien, 2026-09-13.)
 */

/** Un graphe d'un seul bloc, du type demandé. */
function graphe(type: string, data: Record<string, unknown> = {}): WorkflowGraph {
  return { nodes: [{ id: 'a', type, data, position: { x: 0, y: 0 } }], edges: [] } as unknown as WorkflowGraph;
}

/** Les dépendances minimales, plus ce que le test veut observer. */
function deps(over: Partial<WorkflowExecutorDeps> = {}): WorkflowExecutorDeps {
  return {
    runs: { start: async () => ({ id: 'r1' }), findWaitingByWaId: async () => null, setState: async () => {}, closeActiveByWaId: async () => [] },
    removeTag: async () => {},
    // ⚠️ La fenêtre de 24 h est OUVERTE dans ces cas : un message rapide ou une question sont des messages
    // de SESSION, et sans elle ils ne partiraient pas du tout, ce qui viderait les témoins de ce fichier.
    isWindowOpen: async () => true,
    sendTemplate: vi.fn(async () => undefined),
    sendQuickMessage: vi.fn(async () => undefined),
    sendQuestion: vi.fn(async () => undefined),
    sendFlow: vi.fn(async () => undefined),
    applyTag: vi.fn(async () => true),
    setField: vi.fn(async () => {}),
    clearField: vi.fn(async () => {}),
    getGraph: async () => null,
    ...over,
  } as unknown as WorkflowExecutorDeps;
}

/**
 * Démarre le parcours dans les conditions du cas le plus large : la fenêtre de service est OUVERTE.
 *
 * ⚠️ `startInWindow` ET NON `start`, et ce n'est pas un détail de confort : `start` refuse d'ouvrir par un
 * message de SESSION (message rapide, question, formulaire), ce qui viderait les témoins de la moitié des
 * canaux. C'est le chemin d'une automation déclenchée par un message entrant, donc celui où un contact
 * désabonné est le plus susceptible d'être atteint.
 */
async function demarrer(d: WorkflowExecutorDeps, g: WorkflowGraph): Promise<void> {
  await new WorkflowExecutor(d).startInWindow('t1', 'wf1', g, { waId: '33600000000', contactId: 'c1' });
}

describe('la garde d’opt-out des envois automatiques', () => {
  it('🔴 un SCÉNARIO n’envoie RIEN à un contact désabonné', async () => {
    const d = deps({ estDesabonne: async () => true });
    await demarrer(d, graphe('template', { templateName: 'promo', language: 'fr' }));
    expect(d.sendTemplate).not.toHaveBeenCalled();
  });

  /**
   * 🔴 CHAQUE CANAL, ET DANS LES DEUX SENS. Un trou sur un seul canal est invisible : rien ne lève d'erreur,
   * le message part simplement.
   *
   * ⚠️ LES DEUX SENS NE SONT PAS DE LA CÉRÉMONIE ICI, ILS SONT LA SEULE DÉFENSE CONTRE UN TEST VIDE. Un
   * `not.toHaveBeenCalled()` passe aussi quand le bloc n'a produit AUCUNE action, par exemple si ses données
   * ne portent pas la bonne clé. C'est exactement ce qui est arrivé à la première version de ce cas : elle
   * écrivait `{ text }` là où un message rapide lit `body`, et elle passait sur du code sans garde.
   */
  it('🔴 ...et cela vaut pour CHAQUE canal, pas seulement le modèle', async () => {
    for (const [type, data, dep] of [
      ['template', { templateName: 'promo', language: 'fr' }, 'sendTemplate'],
      ['quick_message', { body: 'coucou' }, 'sendQuickMessage'],
      ['question', { body: 'ça va ?', buttonLabel: 'Voir' }, 'sendQuestion'],
      ['flow', { flowId: 'f1', body: 'un formulaire', cta: 'Ouvrir' }, 'sendFlow'],
    ] as const) {
      const passant = deps({ estDesabonne: async () => false });
      await demarrer(passant, graphe(type, data as Record<string, unknown>));
      expect(passant[dep as 'sendTemplate'], `${type} : le cas témoin n’envoie rien, le test serait vide`)
        .toHaveBeenCalledTimes(1);

      const bloque = deps({ estDesabonne: async () => true });
      await demarrer(bloque, graphe(type, data as Record<string, unknown>));
      expect(bloque[dep as 'sendTemplate'], `${type} est passé malgré l’opt-out`).not.toHaveBeenCalled();
    }
  });

  /**
   * ⚠️ L'AUTRE SENS, sans quoi une implémentation qui n'enverrait JAMAIS rien passerait tout ce qui
   * précède. C'est le cas courant : l'écrasante majorité des contacts n'est pas désabonnée.
   */
  it('⚠️ un contact NON désabonné reçoit normalement', async () => {
    const d = deps({ estDesabonne: async () => false });
    await demarrer(d, graphe('template', { templateName: 'promo', language: 'fr' }));
    expect(d.sendTemplate).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 ON SAUTE L'ENVOI, ON N'ARRÊTE PAS LE PARCOURS. Un scénario qui pose un tag « a dit stop » ou range
   * une information doit continuer à le faire : ce qu'on refuse est de lui PARLER, pas de tenir sa fiche.
   */
  it('🔴 les effets qui n’envoient rien continuent : on refuse de parler, pas de noter', async () => {
    const d = deps({ estDesabonne: async () => true });
    const g = {
      nodes: [
        { id: 'a', type: 'tag', data: { tag: 'a-dit-stop' }, position: { x: 0, y: 0 } },
        { id: 'b', type: 'template', data: { templateName: 'promo', language: 'fr' }, position: { x: 0, y: 0 } },
      ],
      edges: [{ id: 'e', source: 'a', target: 'b' }],
    } as unknown as WorkflowGraph;
    await demarrer(d, g);
    expect(d.applyTag).toHaveBeenCalledTimes(1);
    expect(d.sendTemplate).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ UNE SEULE LECTURE PAR LISTE D'EFFETS. Un parcours peut enchaîner plusieurs envois, et poser la
   * question à chacun paierait une requête par message pour une réponse qui ne change pas entre-temps.
   */
  it('⚠️ la question n’est posée qu’UNE fois, même sur trois envois', async () => {
    const estDesabonne = vi.fn(async () => true);
    const d = deps({ estDesabonne });
    const g = {
      nodes: [
        { id: 'a', type: 'quick_message', data: { body: 'un' }, position: { x: 0, y: 0 } },
        { id: 'b', type: 'quick_message', data: { body: 'deux' }, position: { x: 0, y: 0 } },
        { id: 'c', type: 'quick_message', data: { body: 'trois' }, position: { x: 0, y: 0 } },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'c' }],
    } as unknown as WorkflowGraph;
    await demarrer(d, g);
    expect(estDesabonne).toHaveBeenCalledTimes(1);
  });

  it('⚠️ sans la dépendance câblée, rien ne change : c’est un défaut PERMISSIF, tenu par le test de câblage', async () => {
    const d = deps();
    await demarrer(d, graphe('template', { templateName: 'promo', language: 'fr' }));
    expect(d.sendTemplate).toHaveBeenCalledTimes(1);
  });
});

describe('la définition de « envoyer » ne peut pas dériver', () => {
  /**
   * 🔴 LA LISTE `EST_UN_ENVOI` EST LA DÉFINITION DE LA GARDE. En oublier un `kind` rouvrirait le trou pour
   * ce canal-là sans qu'aucune erreur ne soit levée. Ce test la compare aux `kind` que le dispatch d'`apply`
   * traite RÉELLEMENT comme des envois, lus dans la source.
   */
  it('🔴 tout `kind` que l’exécuteur envoie est dans `EST_UN_ENVOI`', () => {
    const src = readFileSync(new URL('../src/workflow/executor.ts', import.meta.url), 'utf8');
    // Les `kind` passés aux dépendances d'envoi : `this.deps.sendX(` est précédé, dans le dispatch, du test
    // `a.kind === 'sendX'`. On lit donc les noms des dépendances appelées, qui portent le même nom.
    const appels = [...src.matchAll(/this\.deps\.(send[A-Za-z]+)[?.(]/g)].map((m) => m[1]!);
    const envoyes = new Set(appels.filter((n) => n !== 'sendEmail' || true));
    for (const dep of envoyes) {
      expect(EST_UN_ENVOI.has(dep), `« ${dep} » fait partir un message et n’est pas dans EST_UN_ENVOI`).toBe(true);
    }
    expect(envoyes.size, 'aucune dépendance d’envoi lue : ce test ne garde plus rien').toBeGreaterThan(3);
  });
});

describe('le câblage réel fournit la garde', () => {
  /**
   * 🔴 LA DÉPENDANCE EST OPTIONNELLE POUR LES TESTS, DONC SON ABSENCE NE BLOQUE RIEN. C'est acceptable
   * UNIQUEMENT parce que ce test vérifie que la vraie construction la fournit : sans lui, un oubli de
   * branchement rouvrirait le trou en silence, et aucun test de comportement ne le verrait.
   */
  it('🔴 `wiring.ts` branche bien `estDesabonne`', () => {
    const src = readFileSync(new URL('../src/workflow/wiring.ts', import.meta.url), 'utf8');
    const sansCommentaires = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(sansCommentaires, 'la garde d’opt-out n’est plus câblée dans le vrai exécuteur')
      .toMatch(/estDesabonne:\s*\(tenant, waId\)\s*=>\s*contactStore\.estDesabonneParWaId\(tenant, waId\)/);
  });

  /**
   * ⚠️ ET LA RÉPONSE MANUELLE DE L'OPÉRATEUR RESTE EXEMPTE. L'Inbox a son propre envoi, câblé à part dans
   * `src/index.ts` (`sendReply`) : il ne passe pas par l'exécuteur, donc la garde ne le touche pas. Ce test
   * garde cette séparation, qui est ce qui rend l'exemption structurelle plutôt que déclarative.
   */
  it('⚠️ la réponse de l’Inbox ne passe PAS par l’exécuteur', () => {
    const src = readFileSync(new URL('../src/http/inbox.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/sendReply\(/);
    expect(src, 'l’Inbox ne doit pas emprunter l’exécuteur de scénario pour répondre')
      .not.toMatch(/WorkflowExecutor/);
  });
});
