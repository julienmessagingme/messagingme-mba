import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runTurn, type RunTurnDeps } from '../src/agent/run-turn';
import { FakeAgentBrain } from '../src/agent/brain.fake';
import type { FicheAgent } from '../src/agent/agent-store';
import type { AgentTurnJob } from '../src/agent/turn-job';
import { WorkflowExecutor, EST_UN_ENVOI } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph } from '../src/workflow/graph';

/**
 * UN CONTACT DÉSABONNÉ NE REÇOIT RIEN D'AUTOMATIQUE.
 *
 * 🔴 CE QUE CE FICHIER FERME. Mesuré le 2026-09-13 : `optInAllows` n'était appelée qu'aux deux points de
 * départ des campagnes et de l'API publique. Un SCÉNARIO, une AUTOMATION ou un AGENT IA atteignaient donc
 * quelqu'un qui avait écrit STOP.
 *
 * 🔴 ET CE FICHIER A AFFIRMÉ, PENDANT UNE JOURNÉE, QUE « LES TROIS PASSENT PAR LE MÊME EXÉCUTEUR : LA GARDE
 * Y EST POSÉE UNE FOIS ». C'ÉTAIT FAUX POUR L'AGENT. Mesuré en revue du chantier complet, le 2026-09-14 :
 * la réponse d'un agent IA ne passe PAS par `WorkflowExecutor.apply`, elle part par `envoyerTexteAgent`, qui
 * appelle `client.sendText` directement. Seuls ses OUTILS passent par l'exécuteur (`mba_envoyer_bloc` fait
 * `walk` + `apply`). Un contact désabonné continuait donc de recevoir les réponses de l'agent, pendant que
 * l'écran Consentement affirmait au client le contraire. **La garde de l'agent vit dans `run-turn.ts`, au
 * rang de ses plafonds, et elle a ses cas ici, en bas de ce fichier.**
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

/**
 * LES DEUX CHEMINS TRANCHÉS PAR JULIEN LE 2026-09-13, après l'inventaire.
 *
 * 🔴 ILS ÉTAIENT « À LA FRONTIÈRE » et le restent conceptuellement : un modèle envoyé de l'Inbox est un
 * geste d'opérateur, une réponse par MCP vient d'une machine agissant pour un opérateur. Ce que ces tests
 * gardent, ce n'est pas la règle, c'est la DÉCISION : marketing bloqué / service autorisé d'un côté,
 * machine muette de l'autre.
 */
describe('les deux chemins tranchés : modèle de l’Inbox, et agent MCP', () => {
  it('🔴 la route d’envoi de modèle REFUSE en 409 un contact désabonné, sauf en « Service »', () => {
    const src = readFileSync(new URL('../src/http/inbox.ts', import.meta.url), 'utf8');
    const bloc = src.slice(src.indexOf("'/tenants/:tenantId/conversations/:conversationId/send-template'"));
    expect(bloc, 'la garde d’opt-out a disparu de l’envoi de modèle').toMatch(/deps\.estDesabonne/);
    expect(bloc, 'le SERVICE doit rester autorisé').toMatch(/categorie !== 'utility'/);
  });

  /**
   * 🔴 LA CATÉGORIE NE VIENT PAS DU CORPS. `templateCategory` y est présent, mais il est fourni par le
   * navigateur et ne sert qu'aux statistiques : s'en servir comme garde laisserait n'importe qui se
   * déclarer « utility » pour écrire à un contact désabonné.
   */
  it('🔴 la catégorie est lue chez Meta, JAMAIS dans le corps de la requête', () => {
    const src = readFileSync(new URL('../src/http/inbox.ts', import.meta.url), 'utf8');
    const bloc = src.slice(src.indexOf("'/tenants/:tenantId/conversations/:conversationId/send-template'"));
    const garde = bloc.slice(bloc.indexOf('deps.estDesabonne'), bloc.indexOf('// Carousel'));
    expect(garde).toMatch(/deps\.categorieDuModele/);
    expect(garde, 'la garde s’appuierait sur une valeur venue du navigateur').not.toMatch(/templateCategory/);
  });

  /**
   * 🔴 ET LA DÉPENDANCE N'EST BRANCHÉE QUE SUR LE CÂBLAGE MCP. `repondreDansLaFenetre` est PARTAGÉE avec la
   * console : c'est cette asymétrie de câblage qui fait l'exemption de l'opérateur. La brancher des deux
   * côtés rendrait un opérateur muet, ce qui est exactement ce que la décision refuse.
   */
  it('🔴 `estDesabonne` est branchée sur le câblage MCP, et le refus a son propre motif', () => {
    const src = readFileSync(new URL('../src/inbox/repondre.ts', import.meta.url), 'utf8');
    expect(src, 'le refus d’opt-out doit avoir son propre motif, jamais le repli « fenêtre fermée »')
      .toMatch(/motif: 'contact_desabonne'/);
    expect(src, 'la garde ne doit viser que l’origine machine').toMatch(/origine === 'mcp'/);
    const outils = readFileSync(new URL('../src/mcp/outils.ts', import.meta.url), 'utf8');
    expect(outils, 'l’agent doit recevoir la raison exacte, pas « fenêtre fermée »').toMatch(/contact_desabonne/);
  });
});

/**
 * L'AGENT IA : SA PROPRE GARDE, PARCE QU'IL A SON PROPRE CHEMIN D'ENVOI.
 *
 * 🔴 CES CAS MANQUAIENT, ET LEUR ABSENCE N'ÉTAIT PAS VISIBLE. Le plan de la tâche 4 listait bien
 * « l'agent IA non plus », mais la couverture a été considérée acquise parce qu'un commentaire de câblage
 * affirmait que l'agent passait par l'exécuteur. Personne n'a exécuté ce chemin-là. C'est le motif exact que
 * ce dépôt paie le plus souvent : **une justification crue plutôt que mesurée**.
 */
describe('l’agent IA se tait devant un contact désabonné', () => {
  const JOB: AgentTurnJob = {
    tenantId: 't1', runId: 'r1', sessionId: 's1', workflowId: 'wf1',
    nodeId: 'a', waId: '33600', raison: 'message', tours: 0,
  };
  const SESSION = {
    id: 's1', tenantId: 't1', runId: 'r1', agentId: 'ag1', nodeId: 'a', waId: '33600',
    tours: 1, appelsOutils: 0, coutMicroEur: 0, status: 'en_cours', ouvertLe: '2026-09-14T08:00:00.000Z',
  };
  const FICHE: FicheAgent = {
    id: 'ag1', tenantId: 't1', mentionIa: 'Je suis une IA.', mentionIaFrequence: 'session', modele: 'm',
    status: 'active', plafonds: { maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30_000 },
    inactiviteMinutes: 30, contactInconnu: 'lecture_seule',
  };

  function tour(over: Partial<RunTurnDeps> = {}) {
    const envois: string[] = [];
    const clotures: string[] = [];
    const brain = new FakeAgentBrain({ texte: 'Bonjour', sortie: null });
    const deps = {
      sessions: {
        prendreLeTour: async () => SESSION,
        clore: async (_t: string, _id: string, status: string) => { clotures.push(status); },
        ajouterAuTranscript: async () => {},
        ajouterCout: async () => {},
      },
      brain,
      lireRun: async () => ({ status: 'waiting', currentNode: 'a' }),
      lireFiche: async () => FICHE,
      envoyer: async (_t: string, _w: string, texte: string) => { envois.push(texte); },
      ...over,
    } as unknown as RunTurnDeps;
    return { deps, brain, envois, clotures };
  }

  /**
   * 🔴 LE CAS QUI MANQUAIT. Un contact écrit STOP, puis réécrit ; le parcours l'amène au bloc agent. Sans
   * cette garde, l'agent lui répond, et le client répond d'un manquement que son écran de conformité lui
   * dit ne pas exister.
   */
  it('🔴 un contact désabonné ne reçoit RIEN de l’agent', async () => {
    const { deps, brain, envois } = tour({ estDesabonne: async () => true });
    const r = await runTurn(JOB, deps);
    expect(r.fait).toBe('desabonne');
    expect(envois, 'l’agent doit se taire').toEqual([]);
    // 🔴 ET LE MODÈLE N'EST MÊME PAS APPELÉ : payer une réponse qu'on jette serait absurde, et c'est ce que
    // le rang des plafonds existe pour éviter.
    expect(brain.appels, 'le modèle ne doit pas être appelé du tout').toEqual([]);
  });

  /**
   * ⚠️ LE TÉMOIN DANS L'AUTRE SENS, et sans lui le cas précédent passerait aussi sur un tour qui n'envoie
   * JAMAIS rien. C'est la leçon du 2026-09-13, payée sur ce fichier même.
   */
  it('⚠️ ...et un contact JOIGNABLE reçoit normalement', async () => {
    const { deps, brain, envois } = tour({ estDesabonne: async () => false });
    expect((await runTurn(JOB, deps)).fait).toBe('repondu');
    expect(envois).toEqual(['Bonjour']);
    expect(brain.appels).toHaveLength(1);
  });

  /**
   * 🔴 LA SESSION N'EST PAS CLOSE, ET C'EST L'EXEMPTION DE L'OPÉRATEUR. La machine se tait ; le message du
   * contact reste dans l'Inbox, où un humain le voit et peut lui répondre à la main. Clore par une branche
   * d'échec ferait sortir le parcours et effacerait ce point d'attente.
   */
  it('🔴 la session n’est PAS close : un opérateur peut encore répondre', async () => {
    const { deps, clotures } = tour({ estDesabonne: async () => true });
    await runTurn(JOB, deps);
    expect(clotures, 'aucune clôture : le fil reste vivant pour l’humain').toEqual([]);
  });

  /**
   * ⚠️ DÉFAUT PERMISSIF, comme sur l'exécuteur de scénario : sans la dépendance, rien ne change. C'est le
   * test de câblage ci-dessous qui garantit qu'elle est branchée en production.
   */
  it('⚠️ sans la dépendance câblée, le comportement d’avant est conservé', async () => {
    const { deps, envois } = tour();
    expect((await runTurn(JOB, deps)).fait).toBe('repondu');
    expect(envois).toEqual(['Bonjour']);
  });

  it('🔴 `worker.ts` branche bien `estDesabonne` sur le tour d’agent', () => {
    // Le câblage n'a par construction aucun dépendant : la seule question à lui poser est l'inverse,
    // « fournit-il ce que le module attend ? ». Un grep, mais sur le bon fichier et le bon voisinage.
    const src = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const bloc = src.slice(src.indexOf('envoyer: (t, waId, texte) => envoyerTexteAgent') - 2000, src.indexOf('envoyer: (t, waId, texte) => envoyerTexteAgent') + 200);
    expect(bloc, 'la garde d’opt-out a disparu du câblage du tour d’agent').toMatch(/estDesabonne: \(t, waId\) => contactStore\.estDesabonneParWaId/);
  });
});
