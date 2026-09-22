import { describe, it, expect } from 'vitest';
import { FIL_CHANGE_PENDANT_ATTENTE, aChangeDeMain, creerGestesEnvoi, type DepsGestesEnvoi } from '../src/mba/gestes-envoi';
import type { EmpreinteDuFil } from '../src/inbox/store.pg';
import { CONTACT_BLOQUE } from '../src/mba/executer-maison';
import type { WorkflowGraph } from '../src/workflow/graph';

/**
 * Les deux gestes qui ENVOIENT au client depuis le relais de l'agent de Meta (spec 2026-09-21-outils-maison-mba).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : toute issue ratée APRÈS la reprise du fil le rend, exception comprise. Sans ça, le
 * fil restait à nous, hors de « À traiter », et l'agent de Meta muet (revue finale du 2026-09-22).
 */
const WF = '11111111-1111-4111-8111-111111111111';
const CODE = `nod_abc_${'A'.repeat(26)}`;
const noeud = (id: string, type: string, data: Record<string, unknown>) =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as WorkflowGraph['nodes'][number];
const texte = noeud('n1', 'quick_message', { code: CODE, body: 'Voici la brochure', quickReplies: [] });
const suite = noeud('n2', 'quick_message', { body: 'Et ceci', quickReplies: [] });
const GRAPHE: WorkflowGraph = { nodes: [texte, suite], edges: [{ id: 'e0', source: 'n1', target: 'n2' }] };

function faux(o: {
  graphe?: WorkflowGraph | null; ouverte?: boolean;
  envoi?: () => Promise<true | string>; scenario?: () => Promise<true | string | null>; rendreKo?: boolean;
  /** L'empreinte lue AVANT l'attente de fin de tour, puis APRÈS (par défaut, la même). */
  empreinteAvant?: EmpreinteDuFil; empreinteApres?: EmpreinteDuFil; bloqueApres?: boolean;
} = {}) {
  const gestes: string[] = [];
  // Selon le MOMENT, pas selon l'ordre des appels : relire « avant » après l'attente doit se voir.
  let attendu = false;
  const base: EmpreinteDuFil = { detenteur: 'app_workflow', changeLe: '2026-09-22T10:00:00.000Z', dernierEnvoi: 'm1' };
  const deps: DepsGestesEnvoi = {
    graphePublie: async () => (o.graphe === undefined ? GRAPHE : o.graphe),
    fenetreOuverte: async () => o.ouverte ?? true,
    contactId: async () => 'c1',
    envoyerDepuisBloc: async (_t, _w, graphe, contact, noeudId) => {
      gestes.push(`envoi ${noeudId} ${graphe.nodes.length} ${contact.contactId}`);
      return o.envoi ? o.envoi() : true;
    },
    lancerScenario: async (_t, id, waId, ouverte) => {
      gestes.push(`scenario ${id} ${waId} ${ouverte}`);
      return o.scenario ? o.scenario() : true;
    },
    rendreLaMain: async (_t, waId) => {
      gestes.push(`rendu ${waId}`);
      if (o.rendreKo) throw new Error('base indisponible');
    },
    attendreFinDuTour: async (_t, waId) => { gestes.push(`tour ${waId}`); attendu = true; },
    empreinteDuFil: async () => (attendu ? (o.empreinteApres ?? o.empreinteAvant ?? base) : (o.empreinteAvant ?? base)),
    estBloque: async () => o.bloqueApres === true,
  };
  return { g: creerGestesEnvoi(deps), gestes };
}

describe('envoyer un bloc', () => {
  it('🔴 envoie le bloc SEUL (graphe réduit), et ne rend pas le fil sur un succès : l’accusé s’en charge', async () => {
    const { g, gestes } = faux();
    expect(await g.envoyerBloc('t1', 'w1', { workflowId: WF, code: CODE })).toBe(true);
    expect(gestes).toEqual(['tour w1', 'envoi n1 1 c1']);
  });

  it('🔴 un refus APRÈS la reprise du fil le rend, et la raison remonte', async () => {
    const { g, gestes } = faux({ envoi: async () => 'le contact s’est désabonné' });
    expect(await g.envoyerBloc('t1', 'w1', { workflowId: WF, code: CODE })).toBe('le contact s’est désabonné');
    expect(gestes).toEqual(['tour w1', 'envoi n1 1 c1', 'rendu w1']);
  });

  it('🔴 une EXCEPTION après la reprise du fil le rend aussi, et remonte telle quelle', async () => {
    const { g, gestes } = faux({ envoi: async () => { throw new Error('Meta API error (HTTP 400)'); } });
    await expect(g.envoyerBloc('t1', 'w1', { workflowId: WF, code: CODE })).rejects.toThrow('HTTP 400');
    expect(gestes).toEqual(['tour w1', 'envoi n1 1 c1', 'rendu w1']);
  });

  it('⚠️ un rendu qui échoue ne masque pas l’exception d’origine', async () => {
    const { g } = faux({ envoi: async () => { throw new Error('Meta API error (HTTP 400)'); }, rendreKo: true });
    await expect(g.envoyerBloc('t1', 'w1', { workflowId: WF, code: CODE })).rejects.toThrow('HTTP 400');
  });

  it('🔴 la fin du tour de l’agent de Meta est attendue JUSTE AVANT la prise du fil, jamais après (essai du 2026-09-22)', async () => {
    // Prendre le fil pendant que l'agent attend l'outil fait envoyer par Meta « un membre de l'équipe reprendra ».
    const { g, gestes } = faux();
    await g.envoyerBloc('t1', 'w1', { workflowId: WF, code: CODE });
    await g.lancerScenario('t1', 'w1', WF);
    expect(gestes).toEqual(['tour w1', 'envoi n1 1 c1', 'tour w1', `scenario ${WF} w1 true`]);
  });

  it('🔴 la conversation change de main PENDANT l’attente : rien ne part, et le fil n’est pas rendu (revue du 2026-09-22)', async () => {
    // Un opérateur a pris la conversation : l'envoi passerait par-dessus, puis rendrait le fil au robot. Et rendre
    // le fil ici relâcherait un parcours lancé entre-temps.
    const avant: EmpreinteDuFil = { detenteur: 'mba', changeLe: '2026-09-22T10:00:00.000Z', dernierEnvoi: 'm1' };
    const bloc = faux({ empreinteAvant: avant, empreinteApres: { ...avant, detenteur: 'app_human', changeLe: '2026-09-22T10:00:05.000Z' } });
    expect(await bloc.g.envoyerBloc('t1', 'w1', { workflowId: WF, code: CODE })).toBe(FIL_CHANGE_PENDANT_ATTENTE);
    expect(bloc.gestes).toEqual(['tour w1']);
  });

  it('🔴 un parcours lancé PENDANT l’attente réécrit la MÊME valeur, mais il envoie : rien ne part (relecture du 2026-09-22)', async () => {
    // `app_workflow` avant, `app_workflow` après, même date : seul son premier envoi le trahit. Le détenteur seul
    // ne le voyait pas, et notre envoi fermait le parcours qu'on venait de lancer.
    const avant: EmpreinteDuFil = { detenteur: 'app_workflow', changeLe: '2026-09-22T10:00:00.000Z', dernierEnvoi: 'm1' };
    const scen = faux({ empreinteAvant: avant, empreinteApres: { ...avant, dernierEnvoi: 'm2' } });
    expect(await scen.g.lancerScenario('t1', 'w1', WF)).toBe(FIL_CHANGE_PENDANT_ATTENTE);
    expect(scen.gestes).toEqual(['tour w1']);
  });

  it('un fil RENDU à l’agent de Meta pendant l’attente (accusé reçu) n’empêche pas l’envoi : c’est à lui qu’on le prend', async () => {
    const avant: EmpreinteDuFil = { detenteur: 'app_human', changeLe: '2026-09-22T10:00:00.000Z', dernierEnvoi: 'm1' };
    const f = faux({ empreinteAvant: avant, empreinteApres: { ...avant, detenteur: 'mba', changeLe: '2026-09-22T10:00:03.000Z' } });
    expect(await f.g.envoyerBloc('t1', 'w1', { workflowId: WF, code: CODE })).toBe(true);
    expect(f.gestes).toEqual(['tour w1', 'envoi n1 1 c1']);
  });

  it('aChangeDeMain : les cas limites', () => {
    const e: EmpreinteDuFil = { detenteur: 'mba', changeLe: null, dernierEnvoi: null };
    expect(aChangeDeMain(null, null)).toBe(false);
    expect(aChangeDeMain(null, e)).toBe(true);
    expect(aChangeDeMain(e, e)).toBe(false);
    expect(aChangeDeMain(e, { ...e, dernierEnvoi: 'm1' })).toBe(true);
  });

  it('🔴 un contact bloqué PENDANT l’attente ne reçoit rien', async () => {
    for (const geste of ['bloc', 'scenario'] as const) {
      const f = faux({ bloqueApres: true });
      const issue = geste === 'bloc'
        ? await f.g.envoyerBloc('t1', 'w1', { workflowId: WF, code: CODE })
        : await f.g.lancerScenario('t1', 'w1', WF);
      expect(issue).toBe(CONTACT_BLOQUE);
      expect(f.gestes).toEqual(['tour w1']);
    }
  });

  it('un bloc devenu invalide, ou un scénario supprimé, est refusé AVANT toute reprise du fil', async () => {
    const question = noeud('n1', 'quick_message', { code: CODE, body: 'Oui ?', quickReplies: ['Oui'] });
    const a = faux({ graphe: { nodes: [question], edges: [] } });
    expect(await a.g.envoyerBloc('t1', 'w1', { workflowId: WF, code: CODE })).toContain('Lancer un scénario');
    expect(a.gestes).toEqual([]);
    const b = faux({ graphe: null });
    expect(await b.g.envoyerBloc('t1', 'w1', { workflowId: WF, code: CODE })).toContain('n’existe plus');
    expect(b.gestes).toEqual([]);
  });

  it('🔴 fenêtre fermée : un message rapide ne part pas ; un modèle, si', async () => {
    const ferme = faux({ ouverte: false });
    expect(await ferme.g.envoyerBloc('t1', 'w1', { workflowId: WF, code: CODE })).toContain('24 h');
    expect(ferme.gestes).toEqual([]);
    const modele = noeud('n1', 'template', { code: CODE, templateName: 'brochure', language: 'fr', templateButtons: [] });
    const m = faux({ ouverte: false, graphe: { nodes: [modele], edges: [] } });
    expect(await m.g.envoyerBloc('t1', 'w1', { workflowId: WF, code: CODE })).toBe(true);
  });
});

describe('lancer un scénario', () => {
  it('lance avec la fenêtre lue, et ne rend rien sur un succès', async () => {
    const { g, gestes } = faux({ ouverte: false });
    expect(await g.lancerScenario('t1', 'w1', WF)).toBe(true);
    expect(gestes).toEqual(['tour w1', `scenario ${WF} w1 false`]);
  });

  it('🔴 un refus rend le fil ; un scénario inconnu aussi, avec sa raison', async () => {
    const refus = faux({ scenario: async () => 'le scénario ouvre par un message rapide, impossible hors de la fenêtre de 24 h' });
    expect(await refus.g.lancerScenario('t1', 'w1', WF)).toContain('24 h');
    expect(refus.gestes).toEqual(['tour w1', `scenario ${WF} w1 true`, 'rendu w1']);
    const inconnu = faux({ scenario: async () => null });
    expect(await inconnu.g.lancerScenario('t1', 'w1', WF)).toBe('ce scénario n’existe plus');
  });

  it('🔴 une EXCEPTION rend le fil et remonte', async () => {
    const { g, gestes } = faux({ scenario: async () => { throw new Error('coupure réseau'); } });
    await expect(g.lancerScenario('t1', 'w1', WF)).rejects.toThrow('coupure réseau');
    expect(gestes).toEqual(['tour w1', `scenario ${WF} w1 true`, 'rendu w1']);
  });
});
