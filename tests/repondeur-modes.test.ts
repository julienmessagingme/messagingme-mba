import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { jamaisDesabonne } from './consentement';
import { avecGardesDEtatInertes, depsInertes } from './executeur-inerte';
import { aucunRepondeur, bancDuFil, type OptionsBanc } from './banc-du-fil';
import { creerDemarreurScenario, type DemarreurScenario } from '../src/repondeur/scenario';
import { leMbaRepond, modeEffectif, standbyPourNous, MODES_REPONDEUR, type ModeRepondeur } from '../src/repondeur/mode';
import { runControlSweep } from '../src/inbox/control-sweep';
import { evenementMessageSansSuite } from '../src/mba/evenement';
import { WorkflowExecutor } from '../src/workflow/executor';
import { walk } from '../src/workflow/engine';
import { parseGraph, type WorkflowGraph } from '../src/workflow/graph';
import type { RunState, WorkflowRunRow } from '../src/workflow/run-store.pg';
import type { DemandeDeLancement } from '../src/workflow/lancements';

/**
 * QUI RÉPOND AU CLIENT (RC6, A3 et A4) : ce que fait un entrant que personne ne tient, mode par mode, et le bloc
 * « Envoyer au MBA ». Tout tourne sur le VRAI contrôle du fil (`bancDuFil`) et la vraie liste de l'agent de Meta, sur un
 * faux Meta qui note chaque geste : « le MBA ne reçoit rien » se lit dans `appels`, vide.
 */

afterEach(() => { vi.restoreAllMocks(); });

const T = 't1';
const W = '33611223344';
const AG = 'ag-1';
const WF = 'wf-repondeur';
const MSG = 'Bonjour, je voudrais un devis';
const libre = { conversations: { [W]: { owner: 'app_workflow' as const } } };

const remettre = (b: ReturnType<typeof bancDuFil>, o: { redelivre?: boolean; reactionsSeules?: boolean } = {}) =>
  b.fil.remettreSiPersonneNeSuit(T, W, MSG, { rouverte: false, messageDeclencheur: 'wamid.1', ...o });

describe('le mode qui s’applique, et la question « le MBA est-il le répondeur ? »', () => {
  it('🔴 allumé n’est pas répondeur : seul le mode `mba`, avec l’agent de Meta allumé', () => {
    const r = (repondeurMode: ModeRepondeur, mbaEnabled: boolean, cibles: { a?: string; w?: string } = {}) =>
      ({ mbaEnabled, repondeurMode, repondeurAgentId: cibles.a ?? null, repondeurWorkflowId: cibles.w ?? null });
    expect(leMbaRepond(r('mba', true))).toBe(true);
    for (const [mode, cibles] of [['agent', { a: AG }], ['scenario', { w: WF }], ['equipe', {}]] as const) {
      expect(leMbaRepond(r(mode, true, cibles)), mode).toBe(false);
      expect(modeEffectif(r(mode, true, cibles)), mode).toBe(mode);
    }
    expect(leMbaRepond(r('mba', false)), 'un répondeur éteint ne répond pas').toBe(false);
  });

  it('un `standby` d’un contact hors liste est pour nous dans les quatre modes', () => {
    for (const m of MODES_REPONDEUR) expect(standbyPourNous(m), m).toBe(true);
  });
});

describe('🔴 A3 : un entrant que personne ne tient, mode par mode', () => {
  it('mode `equipe` : le fil passe à l’équipe (demande ouverte, marque collante), SANS un appel à Meta', async () => {
    const b = bancDuFil({ ...libre, mbaEnabled: false });
    await remettre(b);
    expect(b.etat(W)).toMatchObject({ owner: 'app_human' });
    expect(b.etat(W)?.escaladeeLe).not.toBeNull();
    expect(b.ecritures).toMatchObject([{ owner: 'app_human', opts: { only: ['app_workflow', 'mba'], ouvreUneDemande: true, escalade: true, par: { cause: 'automatique : le contact écrit, l’équipe répond' } } }]);
    expect(b.appels).toEqual([]);
    expect(b.demarrages).toEqual([]);
  });

  it('mode `equipe` : rien pour une redélivrance, une réaction seule, un contact désabonné ; un fil de l’équipe lui reste, délai écoulé ou non', async () => {
    for (const o of [{ redelivre: true }, { reactionsSeules: true }]) {
      const b = bancDuFil({ ...libre, mbaEnabled: false });
      await remettre(b, o);
      expect(b.ecritures, JSON.stringify(o)).toEqual([]);
    }
    const stop = bancDuFil({ ...libre, mbaEnabled: false, desabonnes: [W] });
    await remettre(stop);
    expect(stop.ecritures).toEqual([]);
    // Une conversation de test n'entre pas dans « À traiter » (relecture de RC6).
    const essai = bancDuFil({ mbaEnabled: false, conversations: { [W]: { owner: 'app_workflow', test: true } } });
    await remettre(essai);
    expect(essai.ecritures).toEqual([]);
    const equipe = bancDuFil({ mbaEnabled: false, conversations: { [W]: { owner: 'app_human', changedAt: null } } });
    await remettre(equipe);
    expect(equipe.ecritures).toEqual([]);
    expect(equipe.etat(W)?.owner).toBe('app_human');
  });

  it('mode `scenario` : réclamé, le scénario part sur le message déclencheur ; le fil n’est pas touché', async () => {
    const b = bancDuFil({ ...libre, mode: 'scenario', repondeurWorkflowId: WF, delaiScenarioS: 7200, mbaEnabled: true });
    await remettre(b);
    expect(b.reclamations).toEqual([{ waId: W, workflowId: WF, delaiS: 7200 }]);
    expect(b.lancementsScenario).toEqual([{ waId: W, workflowId: WF, messageDeclencheur: 'wamid.1' }]);
    expect(b.ecritures).toEqual([]);
    expect(b.appels, 'MBA allumé, en veille : rien').toEqual([]);
  });

  it('mode `scenario`, déjà parti dans le délai : à l’équipe, marquée, et AUCUN lancement', async () => {
    const b = bancDuFil({ ...libre, mode: 'scenario', repondeurWorkflowId: WF, reclamation: 'deja_parti' });
    await remettre(b);
    expect(b.lancementsScenario).toEqual([]);
    expect(b.ecritures).toMatchObject([{ owner: 'app_human', opts: { escalade: true, par: { cause: 'automatique : le scénario répondeur est déjà parti pour ce contact, l’équipe prend la suite' } } }]);
  });

  it('mode `scenario`, scénario injouable ou lancement refusé : à l’équipe, sans marque (comme l’agent IA indisponible)', async () => {
    for (const o of [{ reclamation: 'indisponible' as const }, { lancementScenario: 'refuse' as const }]) {
      const b = bancDuFil({ ...libre, mode: 'scenario', repondeurWorkflowId: WF, ...o });
      await remettre(b);
      expect(b.ecritures, JSON.stringify(o)).toMatchObject([{ owner: 'app_human', opts: { escalade: false, ouvreUneDemande: true } }]);
    }
  });

  it('mode `scenario`, fil de l’équipe au délai écoulé : réclamé PUIS repris aux robots, puis lancé ; déjà parti, il reste à l’équipe', async () => {
    const b = bancDuFil({ mode: 'scenario', repondeurWorkflowId: WF, conversations: { [W]: { owner: 'app_human', changedAt: null } } });
    await remettre(b);
    expect(b.ecritures).toMatchObject([{ owner: 'app_workflow', opts: { only: ['app_human'], saufEscalade: true } }]);
    expect(b.lancementsScenario).toHaveLength(1);
    const deja = bancDuFil({ mode: 'scenario', repondeurWorkflowId: WF, reclamation: 'deja_parti', conversations: { [W]: { owner: 'app_human', changedAt: null } } });
    await remettre(deja);
    expect(deja.ecritures).toEqual([]);
    expect(deja.etat(W)?.owner).toBe('app_human');
  });

  it('🔴 mode `scenario` sur le VRAI démarreur : deux messages à une minute, UN départ et le second à l’équipe ; le lendemain, un nouveau', async () => {
    let maintenant = Date.parse('2026-10-07T09:00:00Z');
    let dernier: number | null = null;
    const lances: DemandeDeLancement[] = [];
    const demarreur: DemarreurScenario = creerDemarreurScenario({
      scenarios: { getById: async (id) => (id === WF ? { graph: { nodes: [{ id: 'q', type: 'quick_message', position: { x: 0, y: 0 }, data: {} }], edges: [] } } : null) },
      // La garde atomique de `PgContactStore.reclamerDepartRepondeur`, en mémoire : une lecture et une écriture sans
      // `await` entre elles, donc indivisibles ici comme l'instruction gardée l'est en base.
      contacts: {
        reclamerDepartRepondeur: async (_t, _w, delaiS) => {
          if (dernier !== null && maintenant - dernier < delaiS * 1000) return false;
          dernier = maintenant;
          return true;
        },
      },
      lancements: { lancer: async (d: DemandeDeLancement) => { lances.push(d); return true; } },
    });
    const banc = (o: OptionsBanc = {}) => bancDuFil({ ...libre, mode: 'scenario', repondeurWorkflowId: WF, repondeur: { ...aucunRepondeur, ...demarreur }, ...o });
    const premier = banc();
    await remettre(premier);
    expect(lances).toMatchObject([{ type: 'repondeur_scenario', tenantId: T, workflowId: WF, waId: W, fenetreOuverte: true, messageDeclencheur: 'wamid.1' }]);
    maintenant += 60_000;
    const second = banc();
    await remettre(second);
    expect(lances).toHaveLength(1);
    expect(second.etat(W)?.owner).toBe('app_human');
    maintenant += 24 * 3600_000;
    await remettre(banc());
    expect(lances).toHaveLength(2);
  });

  it('🔴 la course : deux entrants SIMULTANÉS, un seul départ (la réclamation fait la garde ; en base : le test d’intégration)', async () => {
    let pris = false;
    const lances: string[] = [];
    const demarreur = creerDemarreurScenario({
      scenarios: { getById: async () => ({ graph: { nodes: [{ id: 'q', type: 'tag', position: { x: 0, y: 0 }, data: {} }], edges: [] } }) },
      contacts: { reclamerDepartRepondeur: async () => { if (pris) return false; pris = true; return true; } },
      lancements: { lancer: async (d: DemandeDeLancement) => { lances.push(d.type === 'repondeur_scenario' ? d.waId : d.type); return true; } },
    });
    const b = bancDuFil({ ...libre, mode: 'scenario', repondeurWorkflowId: WF, repondeur: { ...aucunRepondeur, ...demarreur } });
    await Promise.all([remettre(b), remettre(b)]);
    expect(lances).toEqual([W]);
  });

  it('mode `agent` : l’agent IA démarre, l’agent de Meta allumé n’est pas appelé', async () => {
    const b = bancDuFil({ ...libre, mode: 'agent', repondeurAgentId: AG, mbaEnabled: true });
    await remettre(b);
    expect(b.demarrages).toEqual([{ waId: W, agentId: AG, messageDeclencheur: 'wamid.1' }]);
    expect(b.appels).toEqual([]);
  });

  it('mode `mba` (le sens inverse) : l’agent de Meta reçoit le contact, la liste, le release, l’événement', async () => {
    const b = bancDuFil({ ...libre, mode: 'mba', mbaEnabled: true });
    await remettre(b);
    expect(b.appels).toEqual([`ajout:${W}`, `release:${W}`, `evenement:${W}`]);
    expect(b.etat(W)?.owner).toBe('mba');
  });
});

describe('🔴 le MBA allumé en veille ne reçoit RIEN tout seul (remise, « Rendre la main », balayage, fin de parcours)', () => {
  for (const [mode, cibles] of [['agent', { repondeurAgentId: AG }], ['scenario', { repondeurWorkflowId: WF }], ['equipe', {}]] as const) {
    it(`mode « ${mode} » : aucune remise, aucun « Rendre la main », aucun balayage ne lui confie un contact`, async () => {
      const b = bancDuFil({ ...libre, mode, mbaEnabled: true, ...cibles });
      await remettre(b);
      expect(await b.fil.rendreLaMain(T, W, { collaborateur: 'u1' })).toBe('app_workflow');
      const sweep = bancDuFil({ mode, mbaEnabled: true, ...cibles, conversations: { [W]: { owner: 'app_human', changedAt: null } } });
      const rendues = await runControlSweep({
        inbox: { listHeldControl: async () => [{ tenantId: T, waId: W, owner: 'app_human', changedAt: new Date(0), lastMessageAt: new Date(), escaladee: false }] },
        timeouts: { app_human: 1000, mba: 1000, app_workflow: 1000 },
        reglages: { modesParTenant: async () => new Map([[T, mode]]) },
        fil: sweep.fil,
      });
      expect(rendues).toBe(1);
      expect(sweep.etat(W)?.owner, 'rendu aux robots, jamais à l’agent de Meta').toBe('app_workflow');
      expect([...b.appels, ...sweep.appels]).toEqual([]);
      expect([...b.table.keys(), ...sweep.table.keys()]).toEqual([]);
    });
  }

  it('le sens inverse : en mode `mba`, « Rendre la main » et le balayage le confient', async () => {
    const b = bancDuFil({ mode: 'mba', mbaEnabled: true, conversations: { [W]: { owner: 'app_human', changedAt: null } } });
    expect(await b.fil.rendreLaMain(T, W, { collaborateur: 'u1' })).toBe('mba');
    const sweep = bancDuFil({ mode: 'mba', mbaEnabled: true, conversations: { [W]: { owner: 'app_human', changedAt: null } } });
    await runControlSweep({
      inbox: { listHeldControl: async () => [{ tenantId: T, waId: W, owner: 'app_human', changedAt: new Date(0), lastMessageAt: new Date(), escaladee: false }] },
      timeouts: { app_human: 1000, mba: 1000, app_workflow: 1000 },
      reglages: { modesParTenant: async () => new Map([[T, 'mba' as const]]) },
      fil: sweep.fil,
    });
    expect(sweep.etat(W)?.owner).toBe('mba');
    expect(sweep.appels).toContain(`ajout:${W}`);
  });
});

const n = (id: string, type: string, data: Record<string, unknown> = {}) =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as WorkflowGraph['nodes'][number];

/** L'exécuteur à dépendances minimales, qui note les rendus au MBA et les envois au MBA par le bloc. */
function executeur(graph: WorkflowGraph, o: { mbaRepond: boolean; blocLeve?: boolean }) {
  const rendus: string[] = [];
  const blocs: Array<{ waId: string; workflowId: string }> = [];
  const envois: string[] = [];
  const run = { id: 'r1', workflowId: 'wf1', tenantId: T, waId: W, currentNode: 'q', lastMessageId: null };
  const ex = new WorkflowExecutor({
    ...depsInertes,
    estDesabonne: jamaisDesabonne,
    runs: avecGardesDEtatInertes({
      start: async () => ({ id: 'r1' }),
      findWaitingByWaId: async () => run as unknown as WorkflowRunRow,
      setState: async (_id: string, _s: RunState): Promise<void> => {},
      closeActiveByWaId: async () => [],
    }),
    isWindowOpen: async () => true,
    getGraph: async () => graph,
    applyTag: async () => {}, setField: async () => {}, removeTag: async () => {}, clearField: async () => {},
    sendTemplate: async () => {}, sendFlow: async () => {}, sendQuestion: async () => {},
    sendQuickMessage: async (_t: string, _w: string, body: string) => { envois.push(body); },
    mbaActifPour: async () => o.mbaRepond,
    releaseToMba: async (_t: string, waId: string) => { rendus.push(waId); },
    confierAuMbaParLeBloc: async (_t: string, waId: string, workflowId: string) => {
      blocs.push({ waId, workflowId });
      if (o.blocLeve) throw new Error('pooler injoignable');
    },
  });
  return { ex, rendus, blocs, envois };
}

describe('🔴 A3 : la fin d’un parcours ne rend au MBA qu’en mode `mba`', () => {
  const fin: WorkflowGraph = { nodes: [n('q', 'quick_message', { body: 'Un conseiller ?', quickReplies: [{ text: 'Oui' }] })], edges: [] };
  it('MBA en veille (`mbaActifPour` = `leMbaRepond` = faux) : la réponse « à côté » ne lui rend rien', async () => {
    const { ex, rendus } = executeur(fin, { mbaRepond: false });
    await ex.advance(T, W, 'msg1', 'Autre chose');
    expect(rendus).toEqual([]);
  });
  it('le sens inverse : MBA répondeur, le fil lui revient', async () => {
    const { ex, rendus } = executeur(fin, { mbaRepond: true });
    await ex.advance(T, W, 'msg1', 'Autre chose');
    expect(rendus).toEqual([W]);
  });
  it('🔴 et le câblage pose la question du MODE, pas celle de l’allumage', () => {
    // `src/workflow/wiring.ts` construit l'exécuteur de production ; revenu à `.mbaEnabled`, il ferait rendre au MBA en
    // veille chaque parcours fini, et chaque étape sans choix cesserait de bloquer.
    const source = readFileSync(new URL('../src/workflow/wiring.ts', import.meta.url), 'utf8');
    expect(source).toContain('mbaActifPour: async (tenant) => leMbaRepond(await settingsStore.get(tenant)),');
    expect(source).not.toMatch(/mbaActifPour: async \(tenant\) => \(await settingsStore\.get\(tenant\)\)\.mbaEnabled/);
  });
});

describe('🔴 A4 : le bloc « Envoyer au MBA » (`vers_mba`)', () => {
  it('le moteur s’y arrête, terminal, après les actions qui le précèdent ; le graphe se lit', () => {
    const graph: WorkflowGraph = {
      nodes: [n('t', 'tag', { tag: 'chaud' }), n('v', 'vers_mba'), n('apres', 'tag', { tag: 'jamais' })],
      edges: [{ id: 'e1', source: 't', target: 'v' }, { id: 'e2', source: 'v', target: 'apres' }],
    };
    expect(parseGraph(graph)).not.toBeNull();
    const r = walk(graph, 't');
    expect(r.rest).toEqual({ status: 'vers_mba', nodeId: 'v' });
    expect(r.actions.map((a) => a.nodeId)).toEqual(['t']);
  });

  it('🔴 un graphe ANCIEN qui contient `mba_handoff` est toujours traversé en passe-plat (rien n’est confié)', () => {
    const ancien: WorkflowGraph = {
      nodes: [n('h', 'mba_handoff'), n('t', 'tag', { tag: 'apres' })],
      edges: [{ id: 'e1', source: 'h', target: 't' }],
    };
    expect(parseGraph(ancien)).not.toBeNull();
    const r = walk(ancien, 'h');
    expect(r.rest).toEqual({ status: 'done' });
    expect(r.actions.map((a) => a.nodeId)).toEqual(['t']);
  });

  it('🔴 l’exécuteur, au démarrage comme à l’avance : UN envoi au MBA, et SANS second rendu, même en mode `mba`', async () => {
    const graph: WorkflowGraph = { nodes: [n('q', 'quick_message', { body: 'Je vous passe à notre assistant' }), n('v', 'vers_mba')], edges: [{ id: 'e', source: 'q', target: 'v' }] };
    const { ex, rendus, blocs, envois } = executeur(graph, { mbaRepond: true });
    expect(await ex.demarrer('automatisme_ordinaire', T, 'wf-bloc', graph, { waId: W, contactId: null }, { depuis: 'entree', fenetreOuverte: true })).toBe(true);
    expect(envois).toEqual(['Je vous passe à notre assistant']);
    expect(blocs).toEqual([{ waId: W, workflowId: 'wf-bloc' }]);
    expect(rendus).toEqual([]);

    const avance = executeur({ nodes: [n('q', 'quick_message', { body: 'Oui ?', quickReplies: [{ text: 'Oui' }] }), n('v', 'vers_mba')], edges: [{ id: 'e', source: 'q', target: 'v', sourceHandle: 'Oui' }] }, { mbaRepond: true });
    await avance.ex.advance(T, W, 'msg1', 'Oui');
    expect(avance.blocs).toEqual([{ waId: W, workflowId: 'wf1' }]);
    expect(avance.rendus).toEqual([]);
  });

  it('🔴 un échec du bloc ne fait pas échouer le parcours, déjà clos', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const graph: WorkflowGraph = { nodes: [n('v', 'vers_mba')], edges: [] };
    const { ex, blocs } = executeur(graph, { mbaRepond: false, blocLeve: true });
    await expect(ex.demarrer('automatisme_ordinaire', T, 'wf', graph, { waId: W, contactId: null }, { depuis: 'entree', fenetreOuverte: true })).resolves.toBe(true);
    expect(blocs).toHaveLength(1);
  });

  it('🔴 MBA allumé (en veille, mode agent) : le contact sur la liste, UN release, UN événement portant le dernier message, le fil `mba`', async () => {
    const b = bancDuFil({ ...libre, mode: 'agent', repondeurAgentId: AG, mbaEnabled: true });
    expect(await b.fil.envoyerAuMba(T, W, { contenu: MSG, cause: 'automatique : bloc « Envoyer au MBA », scénario Devis' })).toBe('confie');
    expect(b.appels).toEqual([`ajout:${W}`, `release:${W}`, `evenement:${W}`]);
    expect(b.evenements).toEqual([{ waId: W, event: evenementMessageSansSuite(MSG) }]);
    expect([...b.table.keys()]).toEqual([W]);
    expect(b.etat(W)?.owner).toBe('mba');
    expect(b.indisponibles).toEqual([]);
  });

  it('🔴 MBA éteint : le fil à l’équipe (demande ouverte), la frise le dit, aucun appel à Meta', async () => {
    const cause = 'automatique : bloc « Envoyer au MBA », scénario Devis';
    const b = bancDuFil({ ...libre, mbaEnabled: false });
    expect(await b.fil.envoyerAuMba(T, W, { contenu: MSG, cause })).toBe('mba_eteint');
    expect(b.indisponibles).toEqual([{ waId: W, cause }]);
    // 🔴 AVEC la marque : le scénario vient d'écrire, le dernier message est sortant, et sans elle la conversation
    // n'entrerait pas dans « À traiter » (relecture de RC6).
    expect(b.ecritures).toMatchObject([{ owner: 'app_human', opts: { ouvreUneDemande: true, escalade: true, par: { cause } } }]);
    expect(b.etat(W)?.escaladeeLe).not.toBeNull();
    expect(b.appels).toEqual([]);
  });

  it('contact désabonné, ou Meta qui refuse l’ajout : à l’équipe, jamais confié, et le geste ne lève pas', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stop = bancDuFil({ ...libre, desabonnes: [W] });
    expect(await stop.fil.envoyerAuMba(T, W, { contenu: MSG, cause: 'x' })).toBe('non_confie');
    expect(stop.etat(W)?.owner).toBe('app_human');
    expect(stop.appels).toEqual([]);
    const refus = bancDuFil({ ...libre, ajout: ['refuse'] });
    expect(await refus.fil.envoyerAuMba(T, W, { contenu: MSG, cause: 'x' })).toBe('non_confie');
    expect(refus.etat(W)?.owner).toBe('app_human');
    expect(refus.evenements).toEqual([]);
  });
});
