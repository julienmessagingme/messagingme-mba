import { describe, it, expect, vi } from 'vitest';
import { executerFonctionJs, MAX_CODE_JS } from '../src/workflow/fonction-js';
import { walk } from '../src/workflow/engine';
import { WorkflowExecutor, type WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph } from '../src/workflow/graph';

/**
 * LE BAC À SABLE DU BLOC « FONCTION JS ».
 *
 * 🔴 CE FICHIER EST LA PREUVE, PAS LA DOCUMENTATION. On fait tourner ici du code écrit par un client sur
 * NOTRE infrastructure : chaque garde annoncée dans `fonction-js.ts` est exercée pour de vrai, parce qu'une
 * garde qu'on croit posée et qui ne l'est pas est exactement le pire cas.
 *
 * ⚠️ `node:vm` n'aurait passé AUCUN des trois tests d'isolation ci-dessous : on s'en échappe par la chaîne
 * des prototypes. C'est QuickJS compilé en WebAssembly, donc un autre moteur dans un autre tas.
 */
describe('fonction JS : ce qu’elle sait faire', () => {
  it('transforme la valeur d’entrée', async () => {
    expect(await executerFonctionJs('return valeur.toUpperCase();', 'bonjour'))
      .toEqual({ ok: true, valeur: 'BONJOUR' });
  });

  it('une valeur STRUCTURÉE ressort en JSON, comme le bloc « Appel API »', async () => {
    // Deux règles différentes pour deux blocs qui écrivent tous deux dans un champ obligeraient le client à
    // se souvenir de laquelle s'applique.
    expect(await executerFonctionJs('return { a: 1, b: valeur };', 'x'))
      .toEqual({ ok: true, valeur: '{"a":1,"b":"x"}' });
  });

  it('un nombre, un booléen et `null` deviennent du texte lisible', async () => {
    expect((await executerFonctionJs('return valeur.length;', 'abcd')).valeur).toBe('4');
    expect((await executerFonctionJs('return valeur === "oui";', 'oui')).valeur).toBe('true');
    expect((await executerFonctionJs('return null;', 'x')).valeur).toBe('');
  });

  it('le JSON entrant se parse, ce qui est le cas d’usage après un « Appel API »', async () => {
    const r = await executerFonctionJs('return JSON.parse(valeur).statut;', '{"statut":"expédiée"}');
    expect(r).toEqual({ ok: true, valeur: 'expédiée' });
  });
});

describe('🔴 fonction JS : ce qu’elle NE PEUT PAS faire', () => {
  it('🔴 une BOUCLE INFINIE est coupée, elle n’immobilise pas le worker', async () => {
    // Sans le gestionnaire d'interruption, un client bloquerait le process qui traite les messages de TOUS
    // les clients. C'est la garde la plus importante de ce module.
    const t0 = Date.now();
    const r = await executerFonctionJs('while (true) {}', 'x', { delaiMs: 100 });
    expect(r.ok).toBe(false);
    expect(r.erreur).toMatch(/dépassé/);
    // Large, pour ne pas devenir instable sur une machine chargée : ce qui compte est que ça S'ARRÊTE.
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('🔴 il n’y a RIEN à atteindre : ni `require`, ni `process`, ni `fetch`', async () => {
    const r = await executerFonctionJs('return typeof require + "|" + typeof process + "|" + typeof fetch;', 'x');
    expect(r).toEqual({ ok: true, valeur: 'undefined|undefined|undefined' });
  });

  it('🔴 l’évasion classique par le constructeur de fonction ne rend RIEN de notre monde', async () => {
    // Le chemin qui casse `node:vm` : remonter jusqu'au constructeur de fonction pour s'exécuter dans le
    // contexte hôte. Ici il n'y a pas de contexte hôte à atteindre, seulement le bac à sable lui-même.
    const r = await executerFonctionJs('return typeof this.constructor.constructor("return process")();', 'x');
    expect(r.ok === false || r.valeur === 'undefined').toBe(true);
  });

  it('une exception du client est rendue LISIBLE, elle ne lève pas', async () => {
    const r = await executerFonctionJs('throw new Error("mon message");', 'x');
    expect(r.ok).toBe(false);
    expect(r.erreur).toContain('mon message');
  });

  it('une faute de syntaxe est rendue lisible aussi', async () => {
    const r = await executerFonctionJs('return valeur.', 'x');
    expect(r.ok).toBe(false);
    expect(r.erreur).toBeTruthy();
  });

  it('⚠️ du code vide ou trop long est refusé AVANT d’allumer le bac à sable', async () => {
    expect(await executerFonctionJs('   ', 'x')).toEqual({ ok: false, valeur: '', erreur: 'aucun code' });
    const trop = await executerFonctionJs('a'.repeat(MAX_CODE_JS + 1), 'x');
    expect(trop.ok).toBe(false);
    expect(trop.erreur).toMatch(/trop long/);
  });

  it('⚠️ la valeur d’entrée voyage en JSON : une apostrophe ne casse rien', async () => {
    // Passée par concaténation, `l'entrée` fermerait la chaîne et deviendrait du code. C'est l'injection la
    // plus banale, et `JSON.stringify` est ce qui la ferme.
    const r = await executerFonctionJs('return valeur;', "l'entrée \" du client\n");
    expect(r).toEqual({ ok: true, valeur: "l'entrée \" du client\n" });
  });
});

describe('le bloc « Fonction JS » dans le graphe', () => {
  const graphe = (data: Record<string, unknown>): WorkflowGraph => ({
    nodes: [
      { id: 'a', type: 'js', data, position: { x: 0, y: 0 } },
      { id: 'b', type: 'tag', data: { tag: 'suite' }, position: { x: 0, y: 0 } },
    ],
    edges: [{ id: 'e', source: 'a', target: 'b' }],
  });

  it('un bloc réglé produit l’action, et le parcours CONTINUE', () => {
    const r = walk(graphe({ code: 'return valeur;', champSource: 'brut', champCible: 'propre' }), 'a');
    expect(r.actions.map((x) => x.action)).toContainEqual({
      kind: 'fonctionJs', code: 'return valeur;', champSource: 'brut', champCible: 'propre',
    });
  });

  it('⚠️ un bloc À MOITIÉ réglé ne fait RIEN', () => {
    // Le code VIDE compte comme non réglé : l'exécuter écrirait une valeur vide dans le champ cible, ce qui
    // ressemblerait à un échec de la fonction alors que rien n'a été demandé.
    for (const data of [{}, { code: 'return 1;' }, { champSource: 'a', champCible: 'b' }, { code: '  ', champSource: 'a', champCible: 'b' }]) {
      expect(walk(graphe(data), 'a').actions.some((x) => x.action.kind === 'fonctionJs')).toBe(false);
    }
  });
});

describe('🔴 le bloc « Fonction JS » à l’exécution', () => {
  const graph: WorkflowGraph = {
    nodes: [{ id: 'js', type: 'js', data: { code: 'return valeur + "!";', champSource: 'brut', champCible: 'propre' }, position: { x: 0, y: 0 } }],
    edges: [],
  };
  class FakeRuns {
    async closeActiveByWaId(): Promise<string[]> { return []; }
    async start(): Promise<{ id: string }> { return { id: 'r1' }; }
    async setState(): Promise<void> {}
  }
  const deps = (over: Partial<WorkflowExecutorDeps>): WorkflowExecutorDeps => ({
    runs: new FakeRuns() as unknown as WorkflowExecutorDeps['runs'],
    getGraph: async () => graph,
    applyTag: async () => {},
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async () => {},
    sendQuickMessage: async () => {},
    sendFlow: async () => {},
    sendQuestion: async () => {},
    ...over,
  });

  it('🔴 la valeur d’entrée est RELUE à l’exécution, pas prise au walk', async () => {
    // C'est ce qui fait marcher l'enchaînement que le client écrira en premier : « Appel API » qui range une
    // réponse dans un champ, puis « Fonction JS » qui la transforme. Une photo prise au walk servirait la
    // valeur d'AVANT l'appel.
    const setField = vi.fn().mockResolvedValue(undefined);
    const executerJs = vi.fn().mockResolvedValue({ ok: true, valeur: 'FRAIS!' });
    const evalContext = vi.fn().mockResolvedValue({
      fields: { brut: 'frais' }, tags: [], optIn: 'unknown', name: null, phone: null, bsuid: null,
      now: new Date(), timeZone: 'UTC', businessHours: { lundi: { closed: true, open: '09:00', close: '18:00' } } as never,
    });
    const ex = new WorkflowExecutor(deps({ setField, executerJs, evalContext }) as WorkflowExecutorDeps);
    await ex.start('t1', 'wf1', graph, { waId: '33600000001', contactId: null });
    expect(executerJs).toHaveBeenCalledWith('return valeur + "!";', 'frais');
    expect(setField).toHaveBeenCalledWith('t1', '33600000001', 'propre', 'FRAIS!');
  });

  it('🔴 un ÉCHEC vide le champ cible, il ne le laisse pas tel quel', async () => {
    // Même doctrine que le bloc « Appel API » : la suite branche une condition sur ce champ, et une valeur
    // de la veille ferait prendre la bonne branche pour de mauvaises raisons.
    const setField = vi.fn().mockResolvedValue(undefined);
    const ex = new WorkflowExecutor(deps({
      setField,
      executerJs: async () => ({ ok: false, valeur: '' }),
      evalContext: async () => ({
        fields: { brut: 'frais' }, tags: [], optIn: 'unknown', name: null, phone: null, bsuid: null,
        now: new Date(), timeZone: 'UTC', businessHours: { lundi: { closed: true, open: '09:00', close: '18:00' } } as never,
      }),
    } as Partial<WorkflowExecutorDeps>) as WorkflowExecutorDeps);
    await ex.start('t1', 'wf1', graph, { waId: '33600000001', contactId: null });
    expect(setField).toHaveBeenCalledWith('t1', '33600000001', 'propre', '');
  });

  it('⚠️ sans le câblage du bac à sable, le bloc ne fait RIEN et le parcours continue', async () => {
    // Contrat des dépendances optionnelles de ce fichier : une instance sans `executerJs` (suites de tests,
    // instance minimale) traverse le bloc sans écrire.
    const setField = vi.fn().mockResolvedValue(undefined);
    const ex = new WorkflowExecutor(deps({ setField }) as WorkflowExecutorDeps);
    await expect(ex.start('t1', 'wf1', graph, { waId: '33600000001', contactId: null })).resolves.toBeDefined();
    expect(setField).not.toHaveBeenCalled();
  });
});
