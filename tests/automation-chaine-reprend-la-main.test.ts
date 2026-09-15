import { jamaisDesabonne } from './consentement';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAutomations } from '../src/automation/runner';
import type { AutomationRunnerDeps } from '../src/automation/runner';
import { POSSESSEUR_LIEN_CHAINE } from '../src/automation/match';
import type { AutomationEvent, AutomationRow } from '../src/automation/match';
import { WorkflowExecutor } from '../src/workflow/executor';
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
 * Le VRAI exécuteur, avec un fil TENU par quelqu'un d'autre (`mayAct` faux) : c'est tout le sujet. Le câblage
 * du runner reproduit celui du worker, et c'est justement pourquoi le dernier `describe` va lire le worker :
 * un faux câblage bouge avec le code qu'il est censé garder.
 */
function monter(rows: AutomationRow[]) {
  const envois: string[] = [];
  const reprises: string[] = [];
  const execDeps: WorkflowExecutorDeps = {
    estDesabonne: jamaisDesabonne,
    runs: {
      start: async () => ({ id: 'r1' }),
      findWaitingByWaId: async () => null,
      setState: async () => {},
      closeActiveByWaId: async () => [],
    },
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
  const deps: AutomationRunnerDeps = {
    listEnabled: async () => rows,
    lastFiredAt: async () => null,
    markFired: async () => true,
    clearFired: async () => {},
    evalContext: async () => null,
    // Le MÊME câblage que `src/worker.ts` : le drapeau vient du runner, il n'est jamais posé en dur.
    startWorkflow: async (tenant, workflowId, waId, opts) => ex.startInWindow(
      tenant, workflowId, graphe, { waId, contactId: null },
      { emitEvents: true, ignoreHumanControl: opts.reprendLaMain },
    ),
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
 * LE CÂBLAGE ET LA CONSTANTE. Même idiome que `tests/campagne-controle-humain.test.ts` : on DÉRIVE la règle
 * du code réel. Les tests du haut montent un faux câblage, et un faux bouge avec le code qu'il garde.
 */
describe('le câblage réel, et la constante que le SQL recopie', () => {
  it('🔴 le worker passe le drapeau du RUNNER, jamais un `true` en dur', () => {
    const src = lire('src', 'worker.ts');
    const i = src.indexOf('startWorkflow: async (tenant: string, workflowId: string, waId: string, opts: {');
    expect(i, 'le câblage d’automation a changé de signature : ce test ne garde plus rien, le remettre à jour').toBeGreaterThan(-1);
    const bloc = src.slice(i, i + 1800);
    expect(bloc, 'le câblage ne transmet plus la reprise de main : un bouton de chaîne cessera de démarrer sur un fil tenu')
      .toContain('ignoreHumanControl: opts.reprendLaMain');
    // L'autre sens, et il compte autant : posé en dur, TOUTE automation écraserait l'opérateur.
    expect(bloc, 'le câblage pose la reprise de main en dur : n’importe quel mot-clé écraserait un opérateur')
      .not.toContain('ignoreHumanControl: true');
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
});
