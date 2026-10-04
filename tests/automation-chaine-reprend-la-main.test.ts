import { jamaisDesabonne } from './consentement';
import { avecGardesDEtatInertes, depsInertes } from './executeur-inerte';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAutomations } from '../src/automation/runner';
import type { AutomationRunnerDeps } from '../src/automation/runner';
import { POSSESSEUR_LIEN_CHAINE, POSSESSEUR_PUBLICITE, POSSESSEUR_WIDGET, typeDeLancementDe } from '../src/automation/match';
import type { AutomationEvent, AutomationRow } from '../src/automation/match';
import { WorkflowExecutor } from '../src/workflow/executor';
import { creerLancements } from '../src/workflow/lancements';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph } from '../src/workflow/graph';

/**
 * UN BOUTON DE CHAÎNE REPREND LA MAIN SUR LE FIL. UNE AUTOMATION ORDINAIRE, NON.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE, et le prix que ça a coûté de ne pas l'avoir. Julien, le 2026-09-08 : « le
 * message qu'on clique n'aboutit pas au lancement du scénario ». Mesuré en production : le message était bien
 * arrivé, le mot-clé correspondait, l'automation était trouvée et évaluée. C'est le DÉMARRAGE qui était
 * refusé, parce que le fil appartenait à l'agent de Meta depuis la veille.
 *
 * Ce n'était pas un accident isolé : l'espace ayant l'agent de Meta allumé, CHAQUE scénario lui rend le fil
 * en arrivant au bout, pour 24 heures. Le second clic d'un même abonné tombait donc toujours dans cette
 * fenêtre, et il ne se passait rien, en silence des deux côtés.
 *
 * Sa décision, le 2026-09-08 : « quand ça vient d'une chaîne et que ça pointe vers un scénario, ça reprend la
 * main ». C'est la même logique qu'une campagne (qui reprend la main parce qu'un opérateur la déclenche), sauf
 * qu'ici le geste explicite vient du CONTACT : il a cliqué le bouton d'une publication.
 *
 * ⚠️ ET SEULEMENT LA CHAÎNE. Une automation ordinaire par mot-clé qui reprendrait la main ferait écrire un
 * scénario par-dessus l'opérateur en train de répondre, sur n'importe quel message. Les deux sens sont donc
 * gardés ici, et le second compte autant que le premier.
 */

/** Le graphe ouvre par un MESSAGE RAPIDE : c'est ce qu'un bouton de chaîne déclenche, en fenêtre ouverte. */
const graphe: WorkflowGraph = {
  nodes: [{ id: 'a', type: 'quick_message', position: { x: 0, y: 0 }, data: { body: 'Voici votre code : PROMO10' } }],
  edges: [],
};

const auto = (over: Partial<AutomationRow> = {}): AutomationRow => ({
  id: 'a1', tenantId: 't1', name: 'Chaine : je veux mon code promo', enabled: true,
  triggerKind: 'keyword', triggerConfig: { keywords: ['je veux mon code promo'], mode: 'contains' },
  conditionGroup: null, workflowId: 'wf1', startNodeId: null, cooldownSeconds: null,
  maxFiresPerHour: null, possedePar: POSSESSEUR_LIEN_CHAINE, ...over,
});

const clic: AutomationEvent = {
  kind: 'message', waId: '33633921577', body: 'je veux mon code promo !', isNewContact: false, channel: 'whatsapp',
};

/**
 * Le VRAI exécuteur et la VRAIE entrée de lancement, avec un fil TENU par quelqu'un d'autre (`mayAct` faux) :
 * c'est tout le sujet. Le runner construit la demande, type de lancement compris (`typeDeLancementDe`), et le
 * câblage la transmet telle quelle, comme `src/worker.ts` : il n'y a plus de réglage à recopier dans un faux
 * câblage, donc plus rien à aller lire dans le worker.
 */
function monter(rows: AutomationRow[]) {
  const envois: string[] = [];
  const reprises: string[] = [];
  const execDeps: WorkflowExecutorDeps = {
    ...depsInertes,
    estDesabonne: jamaisDesabonne,
    runs: avecGardesDEtatInertes({
      start: async () => ({ id: 'r1' }),
      findWaitingByWaId: async () => null,
      setState: async () => {},
      closeActiveByWaId: async () => [],
    }),
    getGraph: async () => graphe,
    applyTag: async () => {},
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async () => {},
    sendQuickMessage: async (_t, _w, texte) => { envois.push(texte); },
    sendFlow: async () => {},
    sendQuestion: async () => {},
    // Le fil appartient à un opérateur ou à l'agent de Meta.
    mayAct: async () => false,
    reclaimControl: async (_t, waId) => { reprises.push(waId); },
  };
  const ex = new WorkflowExecutor(execDeps);
  const lancements = creerLancements({
    executor: ex,
    scenarios: { getById: async () => ({ graph: graphe }) },
    contacts: { findIdByWaId: async () => null },
  });
  const deps: AutomationRunnerDeps = {
    automations: {
      listEnabled: async () => rows,
      lastFiredAt: async () => null,
      markFired: async () => true,
      clearFired: async () => {},
    },
    evalContext: async () => null,
    // Le MÊME câblage que `src/worker.ts` : la demande vient du runner, rien n'est choisi ici.
    startWorkflow: async (demande) => (await lancements.lancer(demande)) ?? false,
    defaultCooldownSeconds: 0,
  };
  return { deps, envois, reprises };
}

describe('un bouton de chaîne cliqué démarre son scénario même quand le fil est tenu', () => {
  it('🔴 CHAÎNE : le scénario part, et la conduite du fil revient à l’app', async () => {
    const { deps, envois, reprises } = monter([auto()]);
    expect(await runAutomations('t1', clic, deps)).toBe(1);
    expect(envois).toEqual(['Voici votre code : PROMO10']);
    // La reprise n'est pas un détail : sans elle le scénario partirait puis se bloquerait à la 1re réponse.
    expect(reprises).toEqual(['33633921577']);
  });

  it('🔴 PREUVE INVERSE : la MÊME automation sans propriétaire ne part PAS, et rien n’est repris', async () => {
    // C'est ce cas qui empêche « on reprend la main » de devenir « n'importe quel mot-clé écrase l'opérateur
    // qui est en train de répondre au client ». Le seul écart entre les deux tests est `possedePar`.
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, envois, reprises } = monter([auto({ possedePar: null })]);
    expect(await runAutomations('t1', clic, deps)).toBe(0);
    spy.mockRestore();
    expect(envois).toEqual([]);
    expect(reprises).toEqual([]);
  });

  it('un propriétaire INCONNU ne donne pas la reprise non plus', async () => {
    // La règle est nominative, pas « possède un propriétaire quelconque » : un futur propriétaire (un autre
    // canal, un connecteur) hériterait sinon d'un pouvoir que personne ne lui a accordé.
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, envois } = monter([auto({ possedePar: 'un_autre_proprietaire' })]);
    expect(await runAutomations('t1', clic, deps)).toBe(0);
    spy.mockRestore();
    expect(envois).toEqual([]);
  });
});

const lire = (...bouts: string[]): string => readFileSync(join(process.cwd(), ...bouts), 'utf8');

/**
 * LA CONSTANTE QUE LE SQL RECOPIE, le type de lancement de chaque propriétaire, et le câblage qui le transmet. Ce que
 * chaque type reprend est exécuté par `tests/workflow-lancements.test.ts` ; ce que la table ne voit pas, c'est QUEL
 * type le câblage d'automation de `src/worker.ts` passe, d'où le dernier cas.
 */
describe('la constante que le SQL recopie, et le type de chaque propriétaire', () => {
  it('🔴 le worker transmet la demande du RUNNER telle quelle, sans y poser de type', () => {
    // Ce cas lisait `ignoreHumanControl: opts.reprendLaMain` et refusait un `true` en dur. Sa forme a changé, pas son
    // objet : `lancements.lancer({ ...demande, type: 'automatisme_chaine' })` compile, ne rougit aucun test qui
    // exécute la table, et ferait prendre le fil d'un opérateur par n'importe quel mot-clé (relecture du
    // 2026-10-04, mutation essayée). Aucun test unitaire ne monte `main()`, donc on lit le worker.
    const src = lire('src', 'worker.ts');
    const i = src.indexOf('startWorkflow: async (demande: DemandeAutomatisme) =>');
    expect(i, 'le câblage d’automation a changé de forme : ce test ne garde plus rien, le remettre à jour').toBeGreaterThan(-1);
    const ligne = src.slice(i, src.indexOf('\n', i));
    expect(ligne, 'le câblage ne transmet plus la demande du runner telle quelle : le type viendrait d’ailleurs que de `typeDeLancementDe`')
      .toBe('startWorkflow: async (demande: DemandeAutomatisme) => (await lancements.lancer(demande)) ?? false,');
  });

  it('🔴 la constante et les gardes SQL du store de liens disent la MÊME chaîne', () => {
    // `possede_par = 'channelsme_link'` vit en dur dans les requêtes de ce store, où c'est une garde miroir
    // (il ne peut toucher QUE ses propres automations). Un littéral SQL ne se paramètre pas sans transformer
    // une constante en interpolation de chaîne, ce qui a la forme exacte d'une injection à la relecture. Les
    // deux sont donc tenues alignées ici : renommer la constante seule rendrait le store aveugle à ses
    // propres automations, et l'écran des chaînes se viderait sans qu'aucun type ne bouge.
    const store = lire('src', 'channels-me', 'link-store.pg.ts');
    expect(store).toContain(`possede_par = '${POSSESSEUR_LIEN_CHAINE}'`);
    // Et c'est bien cette valeur-là qui est ÉCRITE à la création, sinon les deux moitiés ne se rencontreraient
    // jamais malgré leur accord apparent.
    expect(lire('src', 'index.ts')).toContain(`possedePar: '${POSSESSEUR_LIEN_CHAINE}'`);
  });

  it('🔴 la constante des PUBLICITÉS et les gardes SQL de leur store disent la MÊME chaîne', () => {
    // Même raison que pour les chaînes, et même prix. `possede_par = 'publicite'` vit en dur dans les
    // requêtes de `PgPublicitesStore`, où c'est une GARDE MIROIR : ce store ne peut toucher QUE ses propres
    // automations. Si la constante et le littéral divergeaient, l'automation d'une publicité deviendrait
    // intouchable par son propriétaire ET invisible de l'écran Automations (qui exclut tout `possede_par`
    // non nul) : elle continuerait de déclencher sans que personne puisse l'éteindre.
    const store = lire('src', 'pubs', 'publicites.pg.ts');
    // Elle est ÉCRITE à la création de l'automation...
    expect(store).toContain(`'${POSSESSEUR_PUBLICITE}'`);
    // ...et RELUE dans chacune des gardes, sans quoi les deux moitiés ne se rencontreraient jamais.
    expect(store).toContain(`possede_par = '${POSSESSEUR_PUBLICITE}'`);
  });

  it('🔴 les TROIS propriétaires reprennent la main, eux seuls, et deux d’entre eux épargnent l’opérateur', () => {
    // La règle est NOMINATIVE, pas « possède un propriétaire quelconque » : un futur propriétaire (un autre
    // canal, un connecteur) hériterait sinon d'un pouvoir que personne ne lui a accordé, sans qu'aucun type
    // ne bouge. Les trois cas du haut de ce fichier gardent le sens inverse, celui qui protège un opérateur.
    // C'est le CLIENT qui déclenche une publicité ou un widget (il clique) : un opérateur en train de lui répondre
    // garde la conversation. Le bouton de chaîne, lancement explicite comme une campagne, la lui prend.
    // Remplace `reprendLaMain` et `epargneLOperateur`, et leurs cinq valeurs chacune.
    const p = (possedePar: string | null): AutomationRow => auto({ possedePar });
    expect(typeDeLancementDe(p(POSSESSEUR_LIEN_CHAINE))).toBe('automatisme_chaine');
    expect(typeDeLancementDe(p(POSSESSEUR_PUBLICITE))).toBe('automatisme_publicite_ou_widget');
    // Le widget (lot 3b) : son visiteur arrive souvent sur un fil que l'agent de Meta tient.
    expect(typeDeLancementDe(p(POSSESSEUR_WIDGET))).toBe('automatisme_publicite_ou_widget');
    expect(typeDeLancementDe(p(null))).toBe('automatisme_ordinaire');
    expect(typeDeLancementDe(p('un_autre_proprietaire'))).toBe('automatisme_ordinaire');
  });
});
