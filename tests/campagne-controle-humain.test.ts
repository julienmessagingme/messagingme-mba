import { jamaisDesabonne } from './consentement';
import { avecGardesDEtatInertes, depsInertes } from './executeur-inerte';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph } from '../src/workflow/graph';

/**
 * UNE CAMPAGNE PART-ELLE DANS UN FIL TENU PAR UN HUMAIN ? OUI (lot 5 du plan post-audit, 2026-09-02).
 *
 * 🔴 Pourquoi ce fichier existe : le dépôt portait DEUX règles écrites en sens contraire. `src/inbox/repondre.ts`
 * affirmait « le fil est pris, une campagne ne l'écrasera pas », pendant que les trois câblages réels
 * (`worker.ts` pour la campagne workflow et la campagne node, `index.ts` pour le lancement depuis l'inbox)
 * passaient `ignoreHumanControl: true`. Le comportement est le bon : la campagne est déclenchée par un
 * opérateur, donc c'est un humain qui a la main. C'est le TEXTE qui mentait, et un texte périmé devient une
 * seconde spécification que la prochaine lecture prendra pour argent comptant.
 *
 * ⚠️ LE CÂBLAGE NE SE LIT PLUS ICI (lot « lancements de scénario », 2026-10-04). Les trois cas qui lisaient
 * `ignoreHumanControl: true` dans `worker.ts` et `index.ts` (campagne à scénario, campagne à un bloc, lien de
 * test, Inbox) sont devenus des lignes de `POLITIQUE_DE_LANCEMENT` (`src/workflow/lancements.ts`), exécutées sur
 * le vrai contrôle du fil par `tests/workflow-lancements.test.ts`. Reste ici la règle sur l'exécuteur, et l'écran.
 */

/**
 * Le graphe OUVRE PAR UN TEMPLATE, et ce n'est pas un détail : `start` est le chemin d'une campagne, donc hors
 * fenêtre de 24 h. Un scénario qui ouvrirait par un message rapide serait refusé pour cette raison-là, et le
 * test croirait mesurer le contrôle du fil alors qu'il mesurerait la fenêtre.
 */
const graphe: WorkflowGraph = {
  nodes: [{ id: 'a', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo', language: 'fr' } }],
  edges: [],
};

function exec(over: Partial<WorkflowExecutorDeps> = {}) {
  const envois: string[] = [];
  const reprises: string[] = [];
  const ex = new WorkflowExecutor({
    ...depsInertes,
    estDesabonne: jamaisDesabonne,
    // 🔴 PAS DE `as unknown as` ICI. Cette fabrique en portait un, et il a fait exactement ce qu un double
    // transtypage fait : il a efface le contrat. Quand `closeActiveByWaId` y est devenue requise, le
    // compilateur a nomme les six autres fabriques a completer et a laisse passer celle-ci, qui a plante a
    // l execution. Un faux qui ment au compilateur retire ce fichier du seul filet qui protege les faux.
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
    sendTemplate: async (_t, _w, nom) => { envois.push('tpl:' + nom); },
    sendQuickMessage: async () => {},
    sendFlow: async () => {},
    sendQuestion: async () => {},
    // Le fil est tenu par quelqu'un d'autre : c'est TOUT le sujet.
    mayAct: async () => false,
    reclaimControl: async (_t, waId) => { reprises.push(waId); },
    ...over,
  });
  return { ex, envois, reprises };
}

describe('campagne contre contrôle humain : une seule règle, et c’est celle du code', () => {
  it('🔴 LA CAMPAGNE (`campagne_scenario`), le scénario part MALGRÉ le fil tenu', async () => {
    const { ex, envois, reprises } = exec();
    const issue = await ex.demarrer('campagne_scenario', 't1', 'wf1', graphe, { waId: '33600', contactId: null });
    expect(issue).toBe(true);
    expect(envois).toEqual(['tpl:promo']);
    // Et il REPREND la conduite du fil : sans ça, le scénario partirait puis se bloquerait à la 1re réponse.
    expect(reprises).toEqual(['33600']);
  });

  it('UN DÉCLENCHEMENT AUTOMATIQUE (`automatisme_ordinaire`), il ne part PAS, et le refus est explicite', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ex, envois } = exec();
    const issue = await ex.demarrer('automatisme_ordinaire', 't1', 'wf1', graphe, { waId: '33600', contactId: null });
    spy.mockRestore();
    expect(envois).toEqual([]);
    // Une CHAÎNE, pas un `false` : la campagne affiche la raison exacte au lieu de laisser deviner.
    expect(typeof issue).toBe('string');
    expect(issue).toContain('tenue par un opérateur');
  });
});

const lire = (...bouts: string[]): string => readFileSync(join(process.cwd(), ...bouts), 'utf8');

/**
 * L'ÉCRAN. Les chemins déclenchés par un opérateur (campagne, Inbox) et le lien de test reprennent le fil : la
 * règle est tenue par la table des lancements (`tests/workflow-lancements.test.ts`). Ce qui ne s'y voit pas, c'est
 * ce que l'infobulle en DIT à l'opérateur.
 */
describe('ce que l’écran dit à l’opérateur de la règle des campagnes', () => {
  it('🔴 l’ÉCRAN ne promet pas le contraire à l’opérateur', () => {
    // Le dernier endroit où le mensonge avait survécu, et le pire des trois : ce n'est pas un commentaire de
    // code, c'est l'infobulle du badge « vous avez la main », affichée à l'opérateur sur CHAQUE conversation
    // qu'il détient, en français et en anglais. Elle affirmait que les campagnes ne l'enverraient pas. Un
    // opérateur qui la croit pense le contact protégé d'un envoi de masse : il ne l'est pas, et c'est
    // exactement ce qu'il doit savoir avant de lancer.
    const ui = lire('web', 'app', 'inbox', 'page.tsx');
    expect(ui, 'l’infobulle ne doit plus promettre que les campagnes sautent le contact')
      .not.toContain('les campagnes ne l’enverront pas');
    expect(ui, 'idem en anglais').not.toContain('campaigns will skip it');
    // Et elle doit DIRE ce qui se passe vraiment, pas seulement se taire : un texte muet laisserait l'ancienne
    // croyance intacte dans la tête de qui l'a déjà lu.
    expect(ui, 'l’infobulle doit dire qu’une campagne part quand même').toMatch(/Une campagne, si/);
    // La liste des exceptions a grandi le 2026-09-08. Une infobulle qui en énumère et en oublie une redevient
    // le demi-mensonge qu'elle a mis des semaines à cesser d'être.
    expect(ui, 'l’infobulle doit aussi dire qu’un bouton de chaîne cliqué reprend la main')
      .toMatch(/bouton de chaîne cliqué aussi/);
  });
});
