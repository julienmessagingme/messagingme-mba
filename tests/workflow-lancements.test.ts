import { describe, it, expect, vi } from 'vitest';
import { jamaisDesabonne } from './consentement';
import { avecGardesDEtatInertes, depsInertes } from './executeur-inerte';
import { bancDuFil, ESPACE } from './banc-du-fil';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import { buildWorkflowRuntime } from '../src/workflow/wiring';
import {
  POLITIQUE_DE_LANCEMENT, TYPES_DE_LANCEMENT, creerLancements,
  type DemandeDeLancement, type TypeDeLancement,
} from '../src/workflow/lancements';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';
import type { WorkflowRow } from '../src/workflow/store.pg';
import type { ControlOwner } from '../src/inbox/store.pg';

/**
 * LES LANCEMENTS DE SCÉNARIO, EXÉCUTÉS TYPE PAR TYPE (plan `docs/superpowers/plans/2026-10-04-lancements-de-scenario.md`).
 *
 * 🔴 CE QUE CE FICHIER REMPLACE. Les réglages d'un démarrage (reprendre le fil, épargner l'opérateur, publier les
 * étiquettes, figer le brouillon, lever la fenêtre) étaient posés câblage par câblage dans `src/index.ts` et
 * `src/worker.ts`, et gardés par des tests qui lisaient leur TEXTE (`tests/campagne-controle-humain.test.ts`,
 * `tests/automation-chaine-reprend-la-main.test.ts`, `tests/workflow-graphe-fige.test.ts`,
 * `tests/workflow-test-token-node.test.ts`). Un texte lu ne dit pas ce que le code FAIT : ces cas font désormais
 * tourner le VRAI module (`creerLancements`) sur le VRAI exécuteur, avec le VRAI contrôle du fil (`bancDuFil`).
 *
 * ⚠️ LA TABLE ATTENDUE EST ÉCRITE ICI, PAS DÉRIVÉE DE `POLITIQUE_DE_LANCEMENT` : la comparer à elle-même ne
 * prouverait rien. Elle recopie le tableau du plan, chaque ligne étant le comportement d'avant le lot. Changer une
 * valeur de la politique fait tomber au moins un cas de ce fichier ; c'est voulu.
 */

const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });

/** Ouvre par un MODÈLE, permis à froid : la reprise, la publication et le graphe joué s'y lisent sans que la fenêtre s'en mêle. */
const modele = (version: string): WorkflowGraph => ({
  nodes: [n('t', 'tag', { tag: 'vip' }), n('tpl', 'template', { templateName: version, language: 'fr' })],
  edges: [{ id: 'e1', source: 't', target: 'tpl' }],
});

/** Ouvre par un MESSAGE RAPIDE à bouton, impossible hors de la fenêtre de 24 h : la garde de fenêtre s'y lit. */
const session: WorkflowGraph = { nodes: [n('qm', 'quick_message', { body: 'Bonjour', quickReplies: ['Oui'] })], edges: [] };

/** Les scénarios de l'espace : le publié et le brouillon diffèrent par le nom du modèle, c'est ce qui dit lequel a joué. */
const SCENARIOS: Record<string, Pick<WorkflowRow, 'graph' | 'draftGraph'>> = {
  'wf-modele': { graph: modele('publie'), draftGraph: modele('brouillon') },
  'wf-session': { graph: session, draftGraph: session },
};
/** Le graphe que FOURNIT l'appelant d'un envoi de bloc (le publié réduit au bloc), par scénario. */
const FOURNI: Record<string, WorkflowGraph> = { 'wf-modele': modele('fourni'), 'wf-session': session };
/** Le premier bloc de chaque scénario, celui où démarre un lancement « au bloc ». */
const PREMIER_BLOC: Record<string, string> = { 'wf-modele': 't', 'wf-session': 'qm' };

const WA = '33611223344';

type Reprise = 'bloque_par_un_fil_tenu' | 'reprend' | 'reprend_sauf_operateur';
type Fenetre = 'gardee' | 'selon_preuve' | 'bloc_ou_preuve' | 'levee';

/** 🔴 LE TABLEAU DU PLAN, recopié. Chaque ligne est le comportement d'avant le lot (décision de Julien du 2026-10-04). */
const ATTENDU: Record<TypeDeLancement, { reprise: Reprise; publie: boolean; graphe: 'publie' | 'fourni' | 'brouillon_fige'; fenetre: Fenetre }> = {
  inbox: { reprise: 'reprend', publie: true, graphe: 'publie', fenetre: 'selon_preuve' },
  agent_meta_scenario: { reprise: 'reprend', publie: true, graphe: 'publie', fenetre: 'selon_preuve' },
  agent_meta_bloc: { reprise: 'reprend', publie: false, graphe: 'fourni', fenetre: 'levee' },
  automatisme_ordinaire: { reprise: 'bloque_par_un_fil_tenu', publie: true, graphe: 'publie', fenetre: 'bloc_ou_preuve' },
  automatisme_chaine: { reprise: 'reprend', publie: true, graphe: 'publie', fenetre: 'bloc_ou_preuve' },
  automatisme_publicite_ou_widget: { reprise: 'reprend_sauf_operateur', publie: true, graphe: 'publie', fenetre: 'bloc_ou_preuve' },
  lien_de_test: { reprise: 'reprend', publie: true, graphe: 'brouillon_fige', fenetre: 'levee' },
  campagne_scenario: { reprise: 'reprend', publie: false, graphe: 'publie', fenetre: 'gardee' },
  campagne_bloc: { reprise: 'reprend', publie: false, graphe: 'publie', fenetre: 'levee' },
};

/** Où commence le parcours, pour les types qui en laissent le choix. Un type qui n'a pas ce choix l'ignore. */
interface Variante { workflowId: string; fenetreOuverte?: boolean; auBloc?: boolean }

/** La demande que le câblage de ce type envoie, pour une variante. */
function demandeDe(type: TypeDeLancement, v: Variante): DemandeDeLancement {
  const base = { tenantId: ESPACE, workflowId: v.workflowId };
  const bloc = PREMIER_BLOC[v.workflowId] ?? 'inconnu';
  switch (type) {
    case 'inbox':
    case 'agent_meta_scenario':
      return { ...base, type, waId: WA, fenetreOuverte: v.fenetreOuverte === true };
    case 'agent_meta_bloc':
      return { ...base, type, graphe: FOURNI[v.workflowId] ?? session, contact: { waId: WA, contactId: 'c-appelant' }, noeudId: bloc };
    case 'automatisme_ordinaire':
    case 'automatisme_chaine':
    case 'automatisme_publicite_ou_widget':
      return { ...base, type, waId: WA, blocDeDepart: v.auBloc === true ? bloc : null, fenetreOuverte: v.fenetreOuverte === true };
    case 'lien_de_test':
      return { ...base, type, waId: WA, blocDuJeton: v.auBloc === true ? bloc : null };
    case 'campagne_scenario':
      return { ...base, type, waId: WA, contactId: 'c-campagne' };
    case 'campagne_bloc':
      return { ...base, type, waId: WA, contactId: 'c-campagne', noeudId: bloc };
  }
}

/**
 * Le VRAI exécuteur et la VRAIE entrée de lancement, sur le VRAI contrôle du fil (`bancDuFil` : le module
 * `src/inbox/fil.ts` sur un faux Meta). `detenteur` : qui tient le fil au départ ; le contact est sur la liste de
 * l'agent de Meta, une reprise l'en retire, et c'est l'appel qu'on observe.
 */
function banc(detenteur: ControlOwner = 'app_workflow') {
  const b = bancDuFil({ surLaListe: [WA], conversations: { [WA]: { owner: detenteur } } });
  const envois: string[] = [];
  const emis: string[] = [];
  /** Ce que la création du parcours a transmis : la fiche et le graphe figé. */
  const crees: Array<{ contactId: string | null; fige: WorkflowGraph | null }> = [];
  const lectures: string[] = [];
  const recherches: string[] = [];
  const deps: WorkflowExecutorDeps = {
    ...depsInertes,
    estDesabonne: jamaisDesabonne,
    runs: avecGardesDEtatInertes({
      start: async (_t: string, _w: string, _waId: string, contactId: string | null, _s: unknown, fige: WorkflowGraph | null) => {
        crees.push({ contactId, fige });
        return { id: 'r1' };
      },
      findWaitingByWaId: async () => null,
      setState: async () => {},
      closeActiveByWaId: async () => [],
    }),
    // Jamais lu au démarrage : le graphe joué vient de l'entrée (ou de l'appelant).
    getGraph: async () => null,
    applyTag: async () => true,
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async (_t, _w, nom, _l, _b, params) => { envois.push(`tpl:${nom}${params ? `:${params.join(',')}` : ''}`); },
    sendQuickMessage: async (_t, _w, texte) => { envois.push(`qm:${texte}`); },
    sendFlow: async () => {},
    sendQuestion: async () => {},
    emitTagAdded: async (_t, _w, tag) => { emis.push(tag); },
    mayAct: b.fil.peutAgir,
    reclaimControl: b.fil.reprendrePourLApp,
  };
  const executor = new WorkflowExecutor(deps);
  const lancements = creerLancements({
    executor,
    scenarios: { getById: async (id, t) => { lectures.push(`${t}/${id}`); return SCENARIOS[id] ?? null; } },
    contacts: { findIdByWaId: async (t, waId) => { recherches.push(`${t}/${waId}`); return 'c-fiche'; } },
  });
  return { b, lancements, executor, envois, emis, crees, lectures, recherches };
}

/** Les journaux des refus (fil tenu, fenêtre) ne polluent pas la sortie des tests. */
function silence(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('la table est fermée et complète', () => {
  it('🔴 une politique par type, et un type par ligne du tableau du plan', () => {
    expect(Object.keys(POLITIQUE_DE_LANCEMENT).sort()).toEqual([...TYPES_DE_LANCEMENT].sort());
    expect(Object.keys(ATTENDU).sort()).toEqual([...TYPES_DE_LANCEMENT].sort());
  });
});

describe('la reprise du fil, type par type, sur le vrai contrôle du fil', () => {
  /**
   * L'AGENT DE META TIENT LE FIL. Un lancement qui reprend le retire de la liste de l'agent et prend la conduite
   * pour l'app ; l'automation ordinaire s'arrête devant le fil tenu, sans rien demander à Meta. Remplace les cas
   * qui lisaient `ignoreHumanControl: true` dans le câblage de la campagne (scénario et bloc), du lien de test et
   * de l'Inbox, et `ignoreHumanControl: opts.reprendLaMain` dans celui des automations.
   */
  for (const type of TYPES_DE_LANCEMENT) {
    const { reprise } = ATTENDU[type];
    it(`${type} : l’agent de Meta tient le fil -> ${reprise === 'bloque_par_un_fil_tenu' ? 'rien ne part, rien n’est demandé à Meta' : 'repris, le scénario part'}`, async () => {
      silence();
      const m = banc('mba');
      const issue = await m.lancements.lancer(demandeDe(type, { workflowId: 'wf-modele' }));
      if (reprise === 'bloque_par_un_fil_tenu') {
        expect(issue).toContain('ce déclenchement automatique n\'écrit pas dedans');
        expect(m.envois).toEqual([]);
        expect(m.b.appels).toEqual([]);
        expect(m.b.etat(WA)?.owner).toBe('mba');
      } else {
        expect(issue).toBe(true);
        expect(m.b.appels).toEqual([`retrait:${WA}`]);
        expect(m.b.etat(WA)?.owner).toBe('app_workflow');
      }
    });
  }

  /**
   * UN OPÉRATEUR TIENT LE FIL. Les lancements explicites le lui prennent (campagne, Inbox, chaîne, `/v1/sends`,
   * lien de test, agent de Meta) ; la publicité et le widget le lui laissent, c'est le client qui a cliqué ;
   * l'automation ordinaire ne demande rien. Remplace le cas qui lisait `saufOperateur: opts.saufOperateur === true`
   * dans le câblage des automations.
   */
  for (const type of TYPES_DE_LANCEMENT) {
    const { reprise } = ATTENDU[type];
    it(`${type} : un opérateur tient le fil -> ${reprise === 'reprend' ? 'il le perd, le scénario part' : 'il le garde'}`, async () => {
      silence();
      const m = banc('app_human');
      const issue = await m.lancements.lancer(demandeDe(type, { workflowId: 'wf-modele' }));
      if (reprise === 'reprend') {
        expect(issue).toBe(true);
        expect(m.b.etat(WA)?.owner).toBe('app_workflow');
        return;
      }
      expect(m.envois).toEqual([]);
      expect(m.b.appels).toEqual([]);
      expect(m.b.etat(WA)?.owner).toBe('app_human');
      expect(issue).toContain(reprise === 'reprend_sauf_operateur'
        ? 'ce démarrage, déclenché par le contact, ne lui prend pas la main'
        : 'ce déclenchement automatique n\'écrit pas dedans');
    });
  }
});

describe('la publication des étiquettes : jamais un chemin de masse', () => {
  for (const type of TYPES_DE_LANCEMENT) {
    const { publie } = ATTENDU[type];
    it(`${type} : l’étiquette posée ${publie ? 'publie « tag ajouté »' : 'ne publie RIEN'}`, async () => {
      const m = banc();
      expect(await m.lancements.lancer(demandeDe(type, { workflowId: 'wf-modele' }))).toBe(true);
      expect(m.emis).toEqual(publie ? ['vip'] : []);
    });
  }
});

describe('le graphe joué : seul le lien de test joue le brouillon, et lui seul le fige', () => {
  /**
   * Remplace les cas qui lisaient `figerLeGraphe: true` et `grapheEditable(wf)` dans le câblage du lien de test,
   * et le compte « une seule occurrence de `figerLeGraphe` dans le worker » : un contact réel ne tombe jamais dans
   * un brouillon, et une campagne ne recopie pas son graphe par destinataire.
   */
  for (const type of TYPES_DE_LANCEMENT) {
    const { graphe } = ATTENDU[type];
    it(`${type} : graphe ${graphe}`, async () => {
      const m = banc();
      expect(await m.lancements.lancer(demandeDe(type, { workflowId: 'wf-modele' }))).toBe(true);
      const version = graphe === 'brouillon_fige' ? 'brouillon' : graphe === 'fourni' ? 'fourni' : 'publie';
      expect(m.envois).toEqual([`tpl:${version}`]);
      expect(m.crees.map((c) => c.fige)).toEqual([graphe === 'brouillon_fige' ? modele('brouillon') : null]);
      // Le graphe fourni ne demande aucune lecture : le bloc vient d'être relu par l'appelant, sur le publié.
      expect(m.lectures).toEqual(graphe === 'fourni' ? [] : [`${ESPACE}/wf-modele`]);
    });
  }
});

describe('la garde de fenêtre de 24 h', () => {
  /** Les départs que chaque type peut prendre : une variante qu'un type n'offre pas n'est pas jouée. */
  const VARIANTES: Record<TypeDeLancement, Variante[]> = {
    inbox: [{ workflowId: 'wf-session', fenetreOuverte: false }, { workflowId: 'wf-session', fenetreOuverte: true }],
    agent_meta_scenario: [{ workflowId: 'wf-session', fenetreOuverte: false }, { workflowId: 'wf-session', fenetreOuverte: true }],
    agent_meta_bloc: [{ workflowId: 'wf-session', auBloc: true }],
    automatisme_ordinaire: [
      { workflowId: 'wf-session', fenetreOuverte: false }, { workflowId: 'wf-session', fenetreOuverte: true },
      { workflowId: 'wf-session', fenetreOuverte: false, auBloc: true },
    ],
    automatisme_chaine: [
      { workflowId: 'wf-session', fenetreOuverte: false }, { workflowId: 'wf-session', fenetreOuverte: true },
      { workflowId: 'wf-session', fenetreOuverte: false, auBloc: true },
    ],
    automatisme_publicite_ou_widget: [
      { workflowId: 'wf-session', fenetreOuverte: false }, { workflowId: 'wf-session', fenetreOuverte: true },
      { workflowId: 'wf-session', fenetreOuverte: false, auBloc: true },
    ],
    lien_de_test: [{ workflowId: 'wf-session' }, { workflowId: 'wf-session', auBloc: true }],
    campagne_scenario: [{ workflowId: 'wf-session' }],
    campagne_bloc: [{ workflowId: 'wf-session', auBloc: true }],
  };
  /** La règle du plan, écrite à part de `fenetreLevee` : la comparer à elle-même ne prouverait rien. */
  const levee = (regle: Fenetre, v: Variante): boolean =>
    regle === 'levee' || (regle === 'bloc_ou_preuve' && v.auBloc === true) || ((regle === 'selon_preuve' || regle === 'bloc_ou_preuve') && v.auBloc !== true && v.fenetreOuverte === true);

  for (const type of TYPES_DE_LANCEMENT) {
    for (const v of VARIANTES[type]) {
      const ouverte = levee(ATTENDU[type].fenetre, v);
      const libelle = `${v.auBloc === true ? 'au bloc' : 'à l’entrée'}${v.fenetreOuverte === undefined ? '' : v.fenetreOuverte ? ', fenêtre prouvée' : ', sans preuve'}`;
      it(`${type} (${libelle}) : un message de session en ouverture ${ouverte ? 'part' : 'est refusé'}`, async () => {
        silence();
        const m = banc();
        const issue = await m.lancements.lancer(demandeDe(type, v));
        if (ouverte) {
          expect(issue).toBe(true);
          expect(m.envois).toEqual(['qm:Bonjour']);
        } else {
          expect(issue).toContain('impossible hors de la fenêtre de 24 h');
          expect(m.envois).toEqual([]);
        }
      });
    }
  }
});

describe('ce que l’entrée lit, et ce qu’elle transmet', () => {
  it('🔴 la fiche : cherchée par le numéro, sauf pour la campagne (qui la connaît) et l’envoi de bloc (qui la fournit)', async () => {
    for (const type of TYPES_DE_LANCEMENT) {
      const m = banc();
      await m.lancements.lancer(demandeDe(type, { workflowId: 'wf-modele' }));
      const attendue = type === 'campagne_scenario' || type === 'campagne_bloc' ? 'c-campagne' : type === 'agent_meta_bloc' ? 'c-appelant' : 'c-fiche';
      expect(m.crees.map((c) => c.contactId), type).toEqual([attendue]);
      expect(m.recherches, type).toEqual(attendue === 'c-fiche' ? [`${ESPACE}/${WA}`] : []);
    }
  });

  it('un scénario inconnu rend `null`, avant toute recherche et tout envoi (l’appelant le traduit comme avant)', async () => {
    for (const type of TYPES_DE_LANCEMENT) {
      if (type === 'agent_meta_bloc') continue;
      const m = banc();
      expect(await m.lancements.lancer(demandeDe(type, { workflowId: 'wf-supprime' })), type).toBeNull();
      expect(m.recherches, type).toEqual([]);
      expect(m.envois, type).toEqual([]);
    }
  });

  it('la campagne transmet les variables du premier modèle, déjà résolues', async () => {
    const m = banc();
    const issue = await m.lancements.lancer({ type: 'campagne_scenario', tenantId: ESPACE, workflowId: 'wf-modele', waId: WA, contactId: 'c1', firstTemplateParams: ['Julie'] });
    expect(issue).toBe(true);
    expect(m.envois).toEqual(['tpl:publie:Julie']);
  });

  it('🔴 le lien de test démarre AU BLOC que le jeton désigne, casse tolérée, et refuse lisiblement un bloc absent', async () => {
    // Remplace les cas qui lisaient `blocDesigne(graphe, nodeId)`, `nodeId === null`, `startFromNode` et
    // `startInWindow` dans le câblage : revenir à un démarrage inconditionnel à l'entrée ferait partir le premier
    // message du scénario quand le testeur a scanné le bouton d'un bloc.
    const m = banc();
    expect(await m.lancements.lancer({ type: 'lien_de_test', tenantId: ESPACE, workflowId: 'wf-modele', waId: WA, blocDuJeton: 'TPL' })).toBe(true);
    // Démarré au modèle : l'étiquette du bloc d'avant n'a pas été posée, et c'est le BROUILLON qui joue.
    expect(m.envois).toEqual(['tpl:brouillon']);
    expect(m.emis).toEqual([]);
    silence();
    const absent = banc();
    expect(await absent.lancements.lancer({ type: 'lien_de_test', tenantId: ESPACE, workflowId: 'wf-modele', waId: WA, blocDuJeton: 'zzz' }))
      .toBe('le bloc de départ n’existe plus dans le scénario');
    expect(absent.envois).toEqual([]);
  });
});

/**
 * LE VRAI CÂBLAGE : `buildWorkflowRuntime` construit les lancements sur SON exécuteur, avec ses dépôts. Monté sans
 * base (ses dépôts ne font que retenir le pool), comme dans `tests/controle-du-fil-cablage.test.ts`. Un second
 * exécuteur, ou un autre dépôt de scénarios, ferait diverger l'API et le worker.
 */
describe('buildWorkflowRuntime rend des lancements construits sur son propre exécuteur', () => {
  it('🔴 le démarrage passe par l’exécuteur rendu, avec le scénario et la fiche des dépôts reçus', async () => {
    const inerte = {} as never;
    const lus: string[] = [];
    const { executor, lancements } = buildWorkflowRuntime({
      pool: inerte, queue: { enqueue: async () => {} }, dryRun: true, repo: inerte,
      contactStore: { findIdByWaId: async (t: string, w: string) => { lus.push(`fiche:${t}/${w}`); return 'c-9'; } } as never,
      inboxStore: inerte, settingsStore: inerte,
      workflowStore: { getById: async (id: string, t: string) => { lus.push(`scenario:${t}/${id}`); return SCENARIOS[id] ?? null; } } as never,
      metaCredentials: inerte, metaFactory: inerte, rcsProvider: 'fake', emailTemplates: inerte, emailResolver: inerte,
      numeroDeLEspace: async () => null, runStore: inerte, fil: inerte,
    });
    const demarrer = vi.spyOn(executor, 'demarrer').mockResolvedValue(true);
    expect(await lancements.lancer({ type: 'inbox', tenantId: 't9', workflowId: 'wf-modele', waId: WA, fenetreOuverte: true })).toBe(true);
    expect(lus).toEqual(['scenario:t9/wf-modele', `fiche:t9/${WA}`]);
    expect(demarrer).toHaveBeenCalledWith('inbox', 't9', 'wf-modele', modele('publie'), { waId: WA, contactId: 'c-9' }, { depuis: 'entree', fenetreOuverte: true });
  });
});
