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
 * passent `ignoreHumanControl: true`. Le comportement est le bon : la campagne est déclenchée par un
 * opérateur, donc c'est un humain qui a la main. C'est le TEXTE qui mentait, et un texte périmé devient une
 * seconde spécification que la prochaine lecture prendra pour argent comptant.
 *
 * Le test ne se contente pas de l'exécuteur nu : il vérifie aussi le CÂBLAGE, parce que c'est là que la règle
 * se décide réellement et que rien dans le langage ne relie un commentaire à un appel.
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
    runs: {
      start: async () => ({ id: 'r1' }),
      findWaitingByWaId: async () => null,
      setState: async () => {},
    } as unknown as WorkflowExecutorDeps['runs'],
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
  it('🔴 AVEC ignoreHumanControl (le chemin campagne), le scénario part MALGRÉ le fil tenu', async () => {
    const { ex, envois, reprises } = exec();
    const issue = await ex.start('t1', 'wf1', graphe, { waId: '33600', contactId: null }, undefined, { ignoreHumanControl: true });
    expect(issue).toBe(true);
    expect(envois).toEqual(['tpl:promo']);
    // Et il REPREND la conduite du fil : sans ça, le scénario partirait puis se bloquerait à la 1re réponse.
    expect(reprises).toEqual(['33600']);
  });

  it('SANS le drapeau (déclenchement automatique), il ne part PAS, et le refus est explicite', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ex, envois } = exec();
    const issue = await ex.start('t1', 'wf1', graphe, { waId: '33600', contactId: null });
    spy.mockRestore();
    expect(envois).toEqual([]);
    // Une CHAÎNE, pas un `false` : la campagne affiche la raison exacte au lieu de laisser deviner.
    expect(typeof issue).toBe('string');
    expect(issue).toContain('tenue par un opérateur');
  });
});

/**
 * LE CÂBLAGE. Même idiome que `tests/web-rewrites-liens.test.ts` : on DÉRIVE la règle du code réel plutôt que
 * de la recopier ici. Un test qui n'interrogerait que l'exécuteur passerait au vert le jour où un câblage
 * cesserait de passer le drapeau, et la campagne se bloquerait alors en silence sur chaque contact dont un
 * opérateur a touché le fil.
 */
const lire = (...bouts: string[]): string => readFileSync(join(process.cwd(), ...bouts), 'utf8');

describe('les trois chemins déclenchés par un opérateur passent bien ignoreHumanControl', () => {
  it('🔴 la campagne WORKFLOW et la campagne NODE, dans le worker', () => {
    // ⚠️ L'ancre doit désigner LE câblage de campagne, et rien d'autre. Deux versions de ce test ont accusé
    // le mauvais appel : `workflowExecutor.start(` apparaît six fois dans le worker, et `startWorkflow: async`
    // deux fois (l'automation en pose un aussi, et celui-là ne doit SURTOUT pas passer le drapeau). Les
    // signatures, elles, sont distinctes : `firstTemplateParams` n'existe que sur le chemin campagne.
    const src = lire('src', 'worker.ts');
    for (const dep of ['firstTemplateParams) => {', 'startWorkflowFromNode: async (tenant, workflowId, startNodeId, waId, contactId)']) {
      const i = src.indexOf(dep);
      expect(i, `la dépendance ${dep} a disparu du worker : ce test ne garde plus rien, il faut le remettre à jour`).toBeGreaterThan(-1);
      expect(src.slice(i, i + 600), `${dep} ne passe plus ignoreHumanControl : une campagne se bloquera sur tout fil touché par un opérateur`)
        .toContain('ignoreHumanControl: true');
    }
  });

  it('les déclenchements AUTOMATIQUES, eux, ne le passent pas', () => {
    // La moitié qui compte autant : le drapeau est une exception réservée à ce qu'un opérateur déclenche. Le
    // poser partout reviendrait à écrire dans le fil d'un client pendant qu'un humain lui parle.
    const src = lire('src', 'worker.ts');
    const auto = src.indexOf('startInWindow(tenant, workflowId, grapheEditable(wf)');
    expect(auto).toBeGreaterThan(-1);
    expect(src.slice(auto, auto + 200)).not.toContain('ignoreHumanControl');
  });

  it('🔴 le lancement depuis l’INBOX, dans index.ts', () => {
    // L'opérateur y détient presque toujours le fil, puisqu'il vient d'y écrire.
    expect(lire('src', 'index.ts')).toContain('ignoreHumanControl: true');
  });

  it('🔴 et l’ÉCRAN ne promet pas le contraire à l’opérateur', () => {
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
  });
});
