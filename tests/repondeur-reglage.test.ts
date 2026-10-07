import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { EmailIdentity, UserAuthStore } from '../src/auth/store';
import type { AgentsRouteDeps } from '../src/http/agents';
import { choisirRepondeur, choixDeLAncienneForme, choixDeLAncienneFormeSousLOffre, lireRepondeur, type ChoixRepondeur, type DepsReglageRepondeur } from '../src/repondeur/reglage';
import { DROITS, type Offre } from '../src/offres/offres';
import { creerListeDeLAgent, PAQUET_LISTE } from '../src/mba/liste';
import { modifierAgent } from '../src/agent/gestion';
import type { AgentComplet, PatchAgent } from '../src/agent/agent-store';
import { ficheVide } from '../src/agent/fiche';
import type { LigneHistorique } from '../src/reglages/historique';
import { modeEffectif, type ModeRepondeur } from '../src/repondeur/mode';
import type { WorkflowGraph } from '../src/workflow/graph';
import { agentsInertes } from './routes-inertes';
import { bancDuFil, listeEnMemoire, metaFactice } from './banc-du-fil';

/**
 * « QUI RÉPOND AU CLIENT » (RC6, A2 ; le lot 5 en posait la moitié agent IA). Un seul écrivain, `choisirRepondeur`, pour
 * la carte de l'Accueil et l'outil MCP.
 *
 * 🔴 CE QUE CES CAS GARDENT.
 *  - L'ORDRE : le réglage s'écrit AVANT tout effet de bord ; quitter le mode `mba` retire ENSUITE les contacts de la
 *    liste de l'agent de Meta et reprend ses fils (dans l'autre ordre, une remise passée entre les deux lirait encore
 *    `mba` et remettrait le contact sur la liste).
 *  - LA FIN D'UNE SEULE VOIX : choisir un agent IA n'éteint PLUS l'agent de Meta (aucun appel chez Meta), et allumer
 *    l'agent de Meta en mode `agent` le laisse en veille.
 *  - LES REFUS n'écrivent rien, ni chez Meta, ni chez nous.
 * Ce que la base fait des CHECK à sens unique et de la règle de `setMbaEnabled` : `tests/integration/repondeur.integration.test.ts`.
 */

afterEach(() => { vi.restoreAllMocks(); });

const T = 't1';
const AG = '11111111-1111-4111-8111-111111111111';
const AUTRE = '22222222-2222-4222-8222-222222222222';
const WF = '33333333-3333-4333-8333-333333333333';
const WF_VIDE = '44444444-4444-4444-8444-444444444444';
const AUTEUR = { userId: 'u1', origine: 'formulaire' as const };
const GRAPHE: WorkflowGraph = { nodes: [{ id: 'q', type: 'quick_message', position: { x: 0, y: 0 }, data: { text: 'Bonjour' } }], edges: [] };

interface EtatReglage {
  mbaEnabled: boolean; repondeurMode: ModeRepondeur; repondeurAgentId: string | null; repondeurWorkflowId: string | null;
  repondeurDelaiScenarioS: number;
}

/** Le réglage et ses dépendances en mémoire, chaque geste noté dans l'ordre. */
function monter(o: {
  etat?: Partial<EtatReglage>; statut?: AgentComplet['status'] | null; gateway?: boolean;
  numero?: string | null; eligible?: boolean | Error; chezMeta?: Error; ecriture?: Error; reprise?: Error; offre?: Offre;
} = {}) {
  const etat: EtatReglage = {
    mbaEnabled: false, repondeurMode: 'equipe', repondeurAgentId: null, repondeurWorkflowId: null, repondeurDelaiScenarioS: 86400,
    ...o.etat,
  };
  const journal: string[] = [];
  const lignes: LigneHistorique[] = [];
  const deps: DepsReglageRepondeur = {
    agents: {
      complet: async (_t, id) => (o.statut === null || id !== AG ? null : { id: AG, label: 'Léa', status: o.statut ?? 'active' }),
    },
    scenarios: {
      getById: async (id) => (id === WF ? { id: WF, name: 'Bienvenue', graph: GRAPHE } : id === WF_VIDE ? { id: WF_VIDE, name: 'Brouillon', graph: { nodes: [], edges: [] } } : null),
      listResume: async () => [{ id: WF, name: 'Bienvenue', nodeCount: 1 }, { id: WF_VIDE, name: 'Brouillon', nodeCount: 0 }],
    },
    reglages: {
      get: async () => ({ ...etat }),
      setRepondeur: async (_t, c) => {
        journal.push(`reglage:${c.mode}`);
        if (o.ecriture) throw o.ecriture;
        etat.repondeurMode = c.mode;
        etat.repondeurAgentId = c.mode === 'agent' ? c.agentId : null;
        etat.repondeurWorkflowId = c.mode === 'scenario' ? c.workflowId : null;
        if (c.mode === 'scenario') etat.repondeurDelaiScenarioS = c.delaiS;
      },
    },
    gatewayDisponible: o.gateway ?? true,
    offres: { offreDe: async () => ({ offre: o.offre ?? 'entreprise', droits: DROITS[o.offre ?? 'entreprise'], retourEnBaseLe: null }) },
    // Le chemin de l'Accueil, en faux : le numéro, l'éligibilité, Meta, puis le drapeau, qui suit la règle de
    // `setMbaEnabled` (allumer quand personne ne répond passe en `mba`).
    activation: {
      numeroDuTenant: async () => (o.numero === undefined ? 'pn1' : o.numero),
      eligible: async () => {
        journal.push('meta:eligible');
        if (o.eligible instanceof Error) throw o.eligible;
        return o.eligible ?? true;
      },
      ecrireChezMeta: async (_t, _pn, enabled) => {
        journal.push(`meta:${enabled ? 'allume' : 'eteint'}`);
        if (o.chezMeta) throw o.chezMeta;
      },
      ecrireDrapeau: async (_t, enabled) => {
        journal.push(`drapeau:${enabled}`);
        etat.mbaEnabled = enabled;
        if (enabled && modeEffectif(etat) === 'equipe') etat.repondeurMode = 'mba';
      },
    },
    liste: { toutRetirer: async () => { journal.push('liste:videe'); return { retires: 3, refuses: 1 }; } },
    historique: { ecrire: async (_t, l) => { lignes.push(l); } },
    fils: {
      reprendreLesFilsDeMeta: async () => {
        journal.push('fils:repris');
        if (o.reprise) throw o.reprise;
        return 2;
      },
    },
  };
  return { deps, etat, journal, lignes };
}

const choisir = (m: ReturnType<typeof monter>, c: ChoixRepondeur) => choisirRepondeur(m.deps, T, c, AUTEUR);

describe('le réglage du répondeur en Base (lot 6, B2a)', () => {
  it('🔴 « MBA » et « Scénario » sont refusés (402, le lien de l’offre), sans RIEN écrire, ni chez Meta ni chez nous', async () => {
    const m = monter({ offre: 'base' });
    expect(await choisir(m, { mode: 'mba' })).toMatchObject({ ok: false, statut: 402, details: { code: 'plan_feature_unavailable', fonction: 'agent_meta' } });
    expect(await choisir(m, { mode: 'scenario', workflowId: WF })).toMatchObject({ ok: false, statut: 402, details: { code: 'plan_feature_unavailable', fonction: 'scenarios' } });
    expect([m.journal, m.lignes]).toEqual([[], []]);
  });

  it('« Agent IA » et « Équipe » restent permis', async () => {
    const m = monter({ offre: 'base' });
    expect(await choisir(m, { mode: 'agent', agentId: AG })).toMatchObject({ ok: true });
    expect(await choisir(m, { mode: 'equipe' })).toMatchObject({ ok: true });
  });

  it('🔴 la lecture dit la vérité sous l’offre : « MBA » écrit se lit « Équipe », la position MBA est grisée, aucun scénario proposé', async () => {
    const m = monter({ offre: 'base', etat: { mbaEnabled: true, repondeurMode: 'mba' } });
    const e = await lireRepondeur(m.deps, T, async () => []);
    expect(e).toMatchObject({ mode: 'mba', modeEffectif: 'equipe', mbaConfigurable: false, scenariosPublies: [] });
    const pro = await lireRepondeur(monter({ offre: 'pro', etat: { mbaEnabled: true, repondeurMode: 'mba' } }).deps, T, async () => []);
    expect(pro).toMatchObject({ modeEffectif: 'mba', mbaConfigurable: true, scenariosPublies: [{ id: WF, name: 'Bienvenue' }] });
  });
});

describe('choisirRepondeur : chaque passage de mode, dans les deux sens', () => {
  it('🔴 équipe → agent IA : AUCUN appel chez Meta, le réglage seul, et sa ligne d’historique sur l’agent', async () => {
    const m = monter();
    const r = await choisir(m, { mode: 'agent', agentId: AG });
    expect(r).toEqual({ ok: true, valeur: { mode: 'agent', agentId: AG, workflowId: null, delaiS: 86400, agentDeMetaAllume: false, liste: { retires: 0, refuses: 0 } } });
    expect(m.journal).toEqual(['reglage:agent']);
    expect(m.lignes).toMatchObject([{ surface: 'agent', surfaceId: AG, element: 'repondeur', libelle: 'Qui répond au client : l’agent IA Léa', acteurId: 'u1' }]);
  });

  it('🔴 MBA → agent IA : l’agent de Meta n’est PAS éteint (veille), mais il cesse de répondre : réglage, PUIS liste vidée, PUIS fils repris', async () => {
    const m = monter({ etat: { mbaEnabled: true, repondeurMode: 'mba' } });
    const r = await choisir(m, { mode: 'agent', agentId: AG });
    expect(r).toMatchObject({ ok: true, valeur: { mode: 'agent', liste: { retires: 3, refuses: 1 } } });
    expect(m.journal).toEqual(['reglage:agent', 'liste:videe', 'fils:repris']);
    expect(m.etat.mbaEnabled, 'allumé = disponible, en veille').toBe(true);
    expect(m.lignes[0]).toMatchObject({ apres: { effets: { liste: { retires: 3, refuses: 1 }, fils: 2 } } });
  });

  it('agent IA → MBA, agent de Meta éteint : éligibilité lue, Meta allumé, drapeau, PUIS le réglage ; la liste n’est pas touchée', async () => {
    const m = monter({ etat: { repondeurMode: 'agent', repondeurAgentId: AG } });
    const r = await choisir(m, { mode: 'mba' });
    expect(r).toMatchObject({ ok: true, valeur: { mode: 'mba', agentId: null, agentDeMetaAllume: true } });
    // Deux lectures d'éligibilité : celle de la carte (configurable ?), puis celle de l'allumage lui-même.
    expect(m.journal).toEqual(['meta:eligible', 'meta:eligible', 'meta:allume', 'drapeau:true', 'reglage:mba']);
    expect(m.etat).toMatchObject({ mbaEnabled: true, repondeurMode: 'mba', repondeurAgentId: null });
    // La ligne d'historique va sur l'agent qu'on quitte : c'est sa page qui la montre.
    expect(m.lignes).toMatchObject([{ surface: 'agent', surfaceId: AG, libelle: 'Qui répond au client : l’agent de Meta' }]);
  });

  it('agent IA → MBA, agent de Meta DÉJÀ allumé (en veille) : aucun appel chez Meta, le réglage seul', async () => {
    const m = monter({ etat: { mbaEnabled: true, repondeurMode: 'agent', repondeurAgentId: AG } });
    expect(await choisir(m, { mode: 'mba' })).toMatchObject({ ok: true, valeur: { mode: 'mba', agentDeMetaAllume: false } });
    expect(m.journal).toEqual(['reglage:mba']);
  });

  it('MBA → équipe : réglage, liste vidée, fils repris ; ligne d’historique sur l’agent de Meta', async () => {
    const m = monter({ etat: { mbaEnabled: true, repondeurMode: 'mba' } });
    expect((await choisir(m, { mode: 'equipe' })).ok).toBe(true);
    expect(m.journal).toEqual(['reglage:equipe', 'liste:videe', 'fils:repris']);
    expect(m.lignes).toMatchObject([{ surface: 'mba', surfaceId: null, libelle: 'Qui répond au client : l’équipe' }]);
  });

  it('équipe → scénario publié, avec son délai ; scénario → équipe : jamais la liste de l’agent de Meta', async () => {
    const m = monter();
    const r = await choisir(m, { mode: 'scenario', workflowId: WF, delaiS: 7200 });
    expect(r).toMatchObject({ ok: true, valeur: { mode: 'scenario', workflowId: WF, delaiS: 7200 } });
    expect(m.lignes[0]).toMatchObject({ libelle: 'Qui répond au client : le scénario Bienvenue (au plus une fois toutes les 2 h par contact)' });
    expect((await choisir(m, { mode: 'equipe' })).ok).toBe(true);
    expect(m.journal).toEqual(['reglage:scenario', 'reglage:equipe']);
    // Le délai survit au mode : le client qui revient au scénario retrouve le sien.
    expect(await choisir(m, { mode: 'scenario', workflowId: WF })).toMatchObject({ ok: true, valeur: { delaiS: 7200 } });
  });

  it('MBA → scénario : la liste est vidée aussi (il quitte le mode `mba`)', async () => {
    const m = monter({ etat: { mbaEnabled: true, repondeurMode: 'mba' } });
    expect((await choisir(m, { mode: 'scenario', workflowId: WF })).ok).toBe(true);
    expect(m.journal).toEqual(['reglage:scenario', 'liste:videe', 'fils:repris']);
  });

  it('un mode `mba` écrit mais agent de Meta éteint, quitté : la liste est vidée quand même (des contacts peuvent y rester)', async () => {
    const m = monter({ etat: { mbaEnabled: false, repondeurMode: 'mba' } });
    expect((await choisir(m, { mode: 'agent', agentId: AG })).ok).toBe(true);
    expect(m.journal).toEqual(['reglage:agent', 'liste:videe', 'fils:repris']);
  });

  it('déjà le réglage en vigueur : rien à faire, rien à journaliser (et le délai compte en mode scénario)', async () => {
    const m = monter({ etat: { repondeurMode: 'agent', repondeurAgentId: AG } });
    expect((await choisir(m, { mode: 'agent', agentId: AG })).ok).toBe(true);
    const s = monter({ etat: { repondeurMode: 'scenario', repondeurWorkflowId: WF, repondeurDelaiScenarioS: 3600 } });
    expect((await choisir(s, { mode: 'scenario', workflowId: WF })).ok).toBe(true);
    expect([...m.journal, ...s.journal, ...m.lignes, ...s.lignes]).toEqual([]);
    expect((await choisir(s, { mode: 'scenario', workflowId: WF, delaiS: 7200 })).ok).toBe(true);
    expect(s.journal).toEqual(['reglage:scenario']);
  });

  it('🔴 une reprise des fils en échec ne défait pas le geste : réglage écrit, ligne d’historique écrite, `fils: null`', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = monter({ etat: { mbaEnabled: true, repondeurMode: 'mba' }, reprise: new Error('pooler injoignable') });
    expect(await choisir(m, { mode: 'agent', agentId: AG })).toMatchObject({ ok: true });
    expect(m.etat.repondeurAgentId).toBe(AG);
    expect(m.lignes).toMatchObject([{ element: 'repondeur', apres: { effets: { fils: null } } }]);
  });
});

describe('choisirRepondeur : les refus n’écrivent RIEN', () => {
  it('🔴 un agent en brouillon, désactivé, inconnu ou mal formé', async () => {
    for (const [o, agent, statut] of [
      [{ statut: 'draft' as const }, AG, 422], [{ statut: 'disabled' as const }, AG, 422], [{ statut: null }, AG, 404],
      [{}, AUTRE, 404], [{}, 'pas-un-uuid', 404],
    ] as const) {
      const m = monter({ etat: { mbaEnabled: true, repondeurMode: 'mba' }, ...o });
      const r = await choisir(m, { mode: 'agent', agentId: agent });
      expect(r.ok ? 200 : r.statut, JSON.stringify(o)).toBe(statut);
      expect(m.journal, JSON.stringify(o)).toEqual([]);
    }
  });

  it('🔴 modèle absent sur l’instance : l’agent IA est refusé (il laisserait chaque contact muet)', async () => {
    const m = monter({ gateway: false });
    expect(await choisir(m, { mode: 'agent', agentId: AG })).toMatchObject({ ok: false, statut: 422 });
    expect(m.journal).toEqual([]);
  });

  it('🔴 un scénario inconnu, mal formé ou jamais publié ; un délai hors de 1 h à 30 jours', async () => {
    for (const [c, statut] of [
      [{ mode: 'scenario', workflowId: AUTRE }, 404], [{ mode: 'scenario', workflowId: 'x' }, 404],
      [{ mode: 'scenario', workflowId: WF_VIDE }, 422],
      [{ mode: 'scenario', workflowId: WF, delaiS: 3599 }, 400], [{ mode: 'scenario', workflowId: WF, delaiS: 2_592_001 }, 400],
      [{ mode: 'scenario', workflowId: WF, delaiS: 3600.5 }, 400],
    ] as const) {
      const m = monter();
      const r = await choisir(m, c);
      expect(r.ok ? 200 : r.statut, JSON.stringify(c)).toBe(statut);
      expect(m.journal, JSON.stringify(c)).toEqual([]);
    }
  });

  it('🔴 MBA non configurable (aucun numéro, ou Meta ne l’a pas ouvert) : 422, rien d’allumé ni d’écrit', async () => {
    for (const o of [{ numero: null }, { eligible: false }]) {
      const m = monter(o);
      expect(await choisir(m, { mode: 'mba' }), JSON.stringify(o)).toMatchObject({ ok: false, statut: 422 });
      expect(m.journal.filter((j) => !j.startsWith('meta:eligible')), JSON.stringify(o)).toEqual([]);
      expect(m.etat.repondeurMode).toBe('equipe');
    }
  });

  it('🔴 Meta ne répond pas ou refuse d’allumer son agent : 409, et RIEN n’est écrit', async () => {
    const illisible = monter({ eligible: new Error('401') });
    expect(await choisir(illisible, { mode: 'mba' })).toMatchObject({ ok: false, statut: 409 });
    expect(illisible.journal).toEqual(['meta:eligible']);
    const refuse = monter({ chezMeta: new Error('403') });
    expect(await choisir(refuse, { mode: 'mba' })).toMatchObject({ ok: false, statut: 409 });
    expect(refuse.journal).toEqual(['meta:eligible', 'meta:eligible', 'meta:allume']);
    expect(refuse.etat).toMatchObject({ mbaEnabled: false, repondeurMode: 'equipe' });
  });

  it('la cible supprimée entre la lecture et l’écriture : 404 lisible (clé étrangère), une autre panne remonte telle quelle', async () => {
    const fk = Object.assign(new Error('violates foreign key constraint'), { code: '23503' });
    expect(await choisir(monter({ ecriture: fk }), { mode: 'agent', agentId: AG })).toMatchObject({ ok: false, statut: 404 });
    await expect(choisir(monter({ ecriture: new Error('pooler injoignable') }), { mode: 'agent', agentId: AG })).rejects.toThrow('pooler injoignable');
  });
});

describe('l’ancienne forme (lot 5 : un agent, ou null), gardée pour l’outil MCP et l’ancienne console', () => {
  it('un agent = le mode `agent` ; null = l’agent de Meta s’il est allumé, sinon l’équipe', () => {
    expect(choixDeLAncienneForme(AG, false)).toEqual({ mode: 'agent', agentId: AG });
    expect(choixDeLAncienneForme(null, true)).toEqual({ mode: 'mba' });
    expect(choixDeLAncienneForme(null, false)).toEqual({ mode: 'equipe' });
  });

  it('🔴 lue sous l’offre (lot 6, B2a) : en Base, null avec l’agent de Meta allumé vaut l’équipe, pas un refus 402', async () => {
    // Sans ça, un espace revenu en Base ne pouvait plus retirer son agent IA répondeur par cette forme.
    const base = monter({ offre: 'base', etat: { mbaEnabled: true } });
    expect(await choixDeLAncienneFormeSousLOffre(base.deps, T, null)).toEqual({ mode: 'equipe' });
    expect(await choixDeLAncienneFormeSousLOffre(base.deps, T, AG)).toEqual({ mode: 'agent', agentId: AG });
    const entreprise = monter({ etat: { mbaEnabled: true } });
    expect(await choixDeLAncienneFormeSousLOffre(entreprise.deps, T, null)).toEqual({ mode: 'mba' });
  });
});

describe('🔴 les fils de l’agent de Meta reviennent aux robots, par le contrôle du fil réel (essai réel du 2026-10-05)', () => {
  it('chaque fil `mba` passe à `app_workflow`, par paquets, avec sa cause ; un fil d’opérateur ou de scénario n’est pas touché', async () => {
    const tenus = Array.from({ length: 205 }, (_, i) => `336${String(i).padStart(8, '0')}`);
    // Les lectures, notées : dans le faux comme en base, un fil repris sort de l'ensemble `mba`, donc sans les compter
    // un paquet unique sans curseur passerait aussi.
    const lectures: Array<{ apres: string | null; limite: number }> = [];
    let lire: ((t: string, apres: string | null, limite: number) => Promise<string[]>) | null = null;
    const banc = bancDuFil({
      depot: { filsDeLAgentDeMeta: (t, apres, limite) => { lectures.push({ apres, limite }); return lire!(t, apres, limite); } },
      mbaEnabled: false, repondeurAgentId: AG,
      conversations: {
        ...Object.fromEntries(tenus.map((w) => [w, { owner: 'mba' as const }])),
        '33700000001': { owner: 'app_human' },
        '33700000002': { owner: 'app_workflow' },
      },
    });
    // Fidèle à `PgInboxStore.filsDeLAgentDeMeta`, sur les lignes du banc.
    lire = async (_t, apres, limite) => [...banc.lignes]
      .filter(([waId, l]) => l.owner === 'mba' && (apres === null || waId > apres))
      .map(([waId]) => waId).sort().slice(0, limite);
    expect(await banc.fil.reprendreLesFilsDeMeta(T)).toBe(tenus.length);
    for (const w of tenus) expect(banc.etat(w)?.owner, w).toBe('app_workflow');
    expect(banc.etat('33700000001')?.owner).toBe('app_human');
    expect(lectures).toEqual([{ apres: null, limite: 200 }, { apres: tenus[199], limite: 200 }]);
    expect(banc.ecritures.map((e) => e.waId).sort()).toEqual(tenus);
    expect(banc.ecritures[0]?.opts).toMatchObject({ only: ['mba'], par: { cause: 'automatique : l’agent de Meta n’est plus le répondeur de l’espace' } });
    // Aucun geste chez Meta : ses contacts viennent d'être retirés de sa liste.
    expect(banc.appels).toEqual([]);
  });
});

describe('🔴 la liste de l’agent de Meta se vide entière, par paquets, un refus n’arrête pas les autres', () => {
  it(`${PAQUET_LISTE * 2 + 5} contacts : tous retirés, sauf celui que Meta refuse, qui reste sur la liste et se compte`, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const contacts = Array.from({ length: PAQUET_LISTE * 2 + 5 }, (_, i) => `336${String(i).padStart(8, '0')}`);
    const table = listeEnMemoire(contacts);
    const refuse = contacts[PAQUET_LISTE + 3]!;
    const faux = metaFactice({}, [], undefined, contacts);
    const client = { ...faux.client, removeFromAllowlist: async (pn: string, entree: string) => {
      if (entree === `entree-${refuse}`) throw new Error('refusé par Meta');
      return faux.client.removeFromAllowlist(pn, entree);
    } };
    const liste = creerListeDeLAgent({ store: table.store, clientMba: async () => client, attendre: async () => {} });
    expect(await liste.toutRetirer(T)).toEqual({ retires: contacts.length - 1, refuses: 1 });
    expect([...table.lignes.keys()]).toEqual([refuse]);
  });
});

describe('🔴 cas 3 de la revue du lot 5 : l’agent répondeur désactivé ou remis en brouillon cesse d’être le répondeur', () => {
  function gestion(statut: AgentComplet['status']) {
    let agent: AgentComplet = {
      id: AG, label: 'Léa', status: statut, mentionIa: 'IA.', modele: 'modele-config', maxTours: 8, maxAppelsOutils: 12,
      budgetMicroEur: 30_000, inactiviteMinutes: 30, contactInconnu: 'tous', contenu: ficheVide(), ficheVersion: 1,
    };
    const oublis: string[] = [];
    const deps: AgentsRouteDeps = {
      ...agentsInertes,
      agents: {
        listActifs: async () => [], listToutes: async () => [], remove: async () => true,
        complet: async () => agent, create: async () => agent,
        patch: async (_t, _id, p: PatchAgent) => { agent = { ...agent, ...(p.status ? { status: p.status } : {}), ...(p.label ? { label: p.label } : {}) }; return agent; },
      },
      modeleParDefaut: 'modele-config',
      oublierRepondeur: async (_t, id) => { oublis.push(id); return true; },
    };
    return { deps, oublis };
  }

  it('désactiver (PATCH de la console ou activate_agent du MCP, la même fonction) : le répondeur est retiré', async () => {
    for (const statut of ['disabled', 'draft'] as const) {
      const g = gestion('active');
      expect((await modifierAgent(g.deps, T, AG, { status: statut }, AUTEUR)).ok).toBe(true);
      expect(g.oublis, statut).toEqual([AG]);
    }
  });

  it('une retouche qui ne touche pas au statut, ou une activation, ne touche pas au répondeur', async () => {
    const g = gestion('disabled');
    await modifierAgent(g.deps, T, AG, { label: 'Léo' }, AUTEUR);
    expect(g.oublis).toEqual([]);
  });

  it('un mode `agent` sans agent (désactivé, supprimé) se lit « Équipe » : la carte peut le signaler', () => {
    expect(modeEffectif({ mbaEnabled: true, repondeurMode: 'agent', repondeurAgentId: null, repondeurWorkflowId: null })).toBe('equipe');
    expect(modeEffectif({ mbaEnabled: false, repondeurMode: 'scenario', repondeurAgentId: null, repondeurWorkflowId: null })).toBe('equipe');
    expect(modeEffectif({ mbaEnabled: false, repondeurMode: 'mba', repondeurAgentId: null, repondeurWorkflowId: null })).toBe('equipe');
  });
});

/** Les routes de la console : admins seulement, l'espace du jeton, un corps validé. */
describe('GET et PUT /tenants/:tenantId/repondeur, et l’ancienne PUT .../agents/repondeur', () => {
  const SECRET = 'secret-repondeur';
  let admin = '';
  let agent = '';
  beforeAll(async () => {
    admin = await signSession({ userId: 'u1', tenantId: T, role: 'admin' }, SECRET);
    agent = await signSession({ userId: 'u2', tenantId: T, role: 'agent' }, SECRET);
  });
  const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });
  const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
  function serveur(etat: Partial<EtatReglage> = { mbaEnabled: true, repondeurMode: 'mba' }) {
    const m = monter({ etat });
    const deps: AgentsRouteDeps = {
      ...agentsInertes,
      agents: {
        listActifs: async () => [{ id: AG, label: 'Léa', status: 'active' } as never], listToutes: async () => [],
        complet: async () => null, create: async () => { throw new Error('x'); }, patch: async () => null, remove: async () => false,
      },
      modeleParDefaut: 'modele-config',
      repondeur: m.deps,
    };
    return { m, srv: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, agents: deps }) };
  }

  it('🔴 GET rend ce que la carte lit en un appel : mode écrit et effectif, cibles, agents actifs, scénarios PUBLIÉS', async () => {
    const { srv } = serveur({ mbaEnabled: false, repondeurMode: 'agent', repondeurAgentId: null });
    const res = await srv.inject({ method: 'GET', url: `/tenants/${T}/repondeur`, ...h(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      mode: 'agent', modeEffectif: 'equipe', agentId: null, workflowId: null, delaiS: 86400,
      mbaAllume: false, mbaConfigurable: true, modeleDisponible: true,
      agentsActifs: [{ id: AG, label: 'Léa' }], scenariosPublies: [{ id: WF, name: 'Bienvenue' }],
    });
  });

  it('🔴 PUT : un admin choisit un scénario (délai en heures) ; la réponse dit ce qui a été fait', async () => {
    const { m, srv } = serveur();
    const res = await srv.inject({ method: 'PUT', url: `/tenants/${T}/repondeur`, ...h(admin), payload: { mode: 'scenario', workflowId: WF, delaiHeures: 48 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: 'scenario', agentId: null, workflowId: WF, delaiS: 172800, agentDeMetaAllume: false, liste: { retires: 3, refuses: 1 } });
    expect(m.lignes[0]).toMatchObject({ origine: 'formulaire', acteurId: 'u1' });
  });

  it('🔴 refusé à un non-admin et à un autre espace, sans rien toucher', async () => {
    const { m, srv } = serveur();
    for (const url of [`/tenants/${T}/repondeur`, `/tenants/${T}/agents/repondeur`]) {
      expect((await srv.inject({ method: 'PUT', url, ...h(agent), payload: { mode: 'equipe', agentId: null } })).statusCode).toBe(403);
    }
    expect((await srv.inject({ method: 'PUT', url: '/tenants/t2/repondeur', ...h(admin), payload: { mode: 'equipe' } })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'GET', url: '/tenants/t2/repondeur', ...h(admin) })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'GET', url: `/tenants/${T}/repondeur`, ...h(agent) })).statusCode).toBe(403);
    expect(m.journal).toEqual([]);
  });

  it('un corps illisible : 400 ; une cible refusée : la phrase de la fonction, avec son statut', async () => {
    const { srv } = serveur();
    for (const payload of [{}, { mode: 'robot' }, { mode: 'agent' }, { mode: 'scenario', workflowId: WF, delaiHeures: 'x' }]) {
      expect((await srv.inject({ method: 'PUT', url: `/tenants/${T}/repondeur`, ...h(admin), payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
    const r = await srv.inject({ method: 'PUT', url: `/tenants/${T}/repondeur`, ...h(admin), payload: { mode: 'agent', agentId: AUTRE } });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'agent introuvable' });
  });

  it('🔴 l’ANCIENNE route garde sa forme : un agent, puis null (agent de Meta allumé, donc « MBA »)', async () => {
    const { m, srv } = serveur();
    const res = await srv.inject({ method: 'PUT', url: `/tenants/${T}/agents/repondeur`, ...h(admin), payload: { agentId: AG } });
    expect(res.statusCode).toBe(200);
    // Elle n'éteint plus l'agent de Meta : la réponse ne peut plus le dire.
    expect(res.json()).toEqual({ repondeurAgentId: AG, agentDeMetaEteint: false, liste: { retires: 3, refuses: 1 } });
    expect((await srv.inject({ method: 'GET', url: `/tenants/${T}/agents`, ...h(admin) })).json()).toMatchObject({ repondeurAgentId: AG });
    const retour = await srv.inject({ method: 'PUT', url: `/tenants/${T}/agents/repondeur`, ...h(admin), payload: { agentId: null } });
    expect(retour.json()).toEqual({ repondeurAgentId: null, agentDeMetaEteint: false, liste: { retires: 0, refuses: 0 } });
    expect(m.etat.repondeurMode).toBe('mba');
    expect((await srv.inject({ method: 'PUT', url: `/tenants/${T}/agents/repondeur`, ...h(admin), payload: { agentId: 12 } })).statusCode).toBe(400);
  });
});
