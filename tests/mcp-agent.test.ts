import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { sha256Hex } from '../src/lib/signature';
import { nouveauJeton, PREFIXE_ACCES } from '../src/oauth/jetons';
import { signSession } from '../src/auth/token';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { AccesOauth, AccesOauthLookup } from '../src/oauth/store.pg';
import type { EmailIdentity, UserAuthStore } from '../src/auth/store';
import { OUTILS, type CablageMcp } from '../src/mcp/outils';
import { OUTILS_NUMERO } from '../src/mcp/outils-numero';
import type { DepsAgentMcp } from '../src/mcp/outils-agent';
import { MESSAGE_OPERATIONS_LOURDES } from '../src/auth/plafond-partage';
import type { AgentComplet, AgentResume, PatchAgent } from '../src/agent/agent-store';
import { ficheVide, fichePatchSchema } from '../src/agent/fiche';
import { saisieDeCreation, saisieDeModification } from '../src/agent/gestion';
import { CreditInsuffisantPourCle } from '../src/agent/provisionner-cle';
import {
  saisieDeFiche, saisieDeListeDeFiches, saisieDeSite, saisieDeSuppression, saisieDeTexteDocument,
  type DepsConnaissance,
} from '../src/agent/connaissance';
import { saisieDEssai, type DepsEssai } from '../src/agent/essai';
import { saisieDOutilsSurs } from '../src/agent/reglages';
import { MODES_TRANSFERT, type ModeTransfert } from '../src/agent/disponibilite-equipe';
import { MODELES_CHOISIS, MODELE_AGENT_CLAUDE_CODE } from '../src/agent/modeles';
import { saisieDePaiement, type DepsPaiement } from '../src/stripe/paiement';
import type { ReponseStripe, TransportStripe } from '../src/stripe/client';
import type { OutilComplet } from '../src/agent/catalog';
import type { LigneHistorique } from '../src/reglages/historique';
import type { ModeRepondeur } from '../src/repondeur/mode';
import type { FicheAEcrire, FicheConnaissance, SourceFiche } from '../src/agent/knowledge';
import type { ContexteAgentComplet, GatewayBrainDeps } from '../src/agent/brain.gateway';
import { creerResolveurSimulation } from '../src/agent/resolvers/simulation';
import { cleApiDeTest } from './aide/cle-api';
import { contactsV1Muets } from './aide/contacts-v1';
import { bornesDesChamps, bornesZod, champsDe, muettes, type Borne } from './aide/bornes-zod';
import { jamaisDesabonne } from './consentement';
import { mcpNumeroInerte, mcpOffreInerte, mcpEtiquettesInertes, mcpInerte, mcpWidgetsInertes } from './routes-inertes';
import { SANS_MCP } from './outils-mcp';
import { AUCUN_GESTE, GESTE_MUET } from './gestes';

/**
 * LES OUTILS MCP DE L'AGENT IA ET DU CRÉDIT (lot 8a, livraison B), montés par `buildServer` derrière la vraie garde
 * de clé d'API et de jeton OAuth.
 *
 * Ce que ces tests protègent, et qui ne se voit pas à la lecture :
 *  1. 🔴 Une clé d'API ne VOIT ni n'APPELLE aucun outil qui exige une personne (spec, section 2) : une clé `mcp:write`
 *     branchée comme connecteur d'un agent qui lit des messages de clients ne doit pas pouvoir, sur une injection,
 *     modifier un agent ou ouvrir un paiement. Le refus est celui d'un outil inconnu.
 *  2. 🔴 Le plafond des opérations coûteuses est celui de la CONSOLE, la même instance et la même clé : le serveur MCP
 *     ne contourne pas les opérations lourdes par minute.
 *  3. 🔴 Chaque outil appelle la fonction de la console avec l'espace du jeton, jamais d'un argument ; un refus garde
 *     la phrase de l'écran ET ses détails (les manques, le code d'un paiement) ; la personne signe.
 *  4. 🔴 `update_agent` n'écrit que ce que la spec permet : les plafonds de coût et la mention d'IA passent par la
 *     même fonction (`modifierAgent`) côté console, et un modèle ne doit pas pouvoir les relever.
 *  5. Toute borne que la console applique est annoncée dans le schéma de l'outil, avec la même valeur.
 */
const AG = '11111111-1111-4111-8111-111111111111';
const AG_NEUF = '33333333-3333-4333-8333-333333333333';
/** Le scénario publié que le mode « scenario » de set_default_responder désigne (RC6). */
const WF_MCP = '55555555-5555-4555-8555-555555555555';
const PERSONNE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET = 'secret-de-test-mcp-agent';

const CLE_ECRITURE = cleApiDeTest('mcp_agent_ecriture');
const JETON = nouveauJeton(PREFIXE_ACCES);
const JETON_LECTURE = nouveauJeton(PREFIXE_ACCES);
const JETON_T2 = nouveauJeton(PREFIXE_ACCES);

class FaussesCles implements ApiKeyLookup {
  async findActiveByHash(hash: string) {
    return hash === sha256Hex(CLE_ECRITURE) ? { id: 'k1', tenantId: 't1', scopes: ['mcp:read', 'mcp:write'] } : null;
  }
  async touchLastUsed() { /* sans objet */ }
}

/** Trois jetons : l'admin de t1 en lecture et écriture, le même en lecture seule, et l'admin d'un autre espace. */
class FauxJetons implements AccesOauthLookup {
  async resoudreAcces(empreinte: string): Promise<AccesOauth | null> {
    const base = { autorisationId: 'a1', userId: PERSONNE, valide: true, tenantStatus: 'active' };
    if (empreinte === JETON.empreinte) return { ...base, tenantId: 't1', scopes: ['mcp:read', 'mcp:write'] };
    if (empreinte === JETON_LECTURE.empreinte) return { ...base, tenantId: 't1', scopes: ['mcp:read'] };
    if (empreinte === JETON_T2.empreinte) return { ...base, tenantId: 't2', scopes: ['mcp:read', 'mcp:write'] };
    return null;
  }
}

const FICHE_COMPLETE = {
  ...ficheVide(),
  objectif: 'Cerner le besoin puis proposer un essai.',
  reglesTransfert: 'Dès qu’on parle de remboursement.',
  sorties: [{ code: 'besoin_cerne', label: 'Besoin cerné' }],
};

const outil = (handler: string, actif: boolean): OutilComplet => ({
  ...SANS_MCP, ...AUCUN_GESTE(),
  id: `id-${handler}`, tenantId: 't1', origin: 'mba', name: `mba_${handler}`,
  title: handler, description: 'd', nePasUtiliser: '', params: [], binding: { handler },
  sourceId: null, requestId: null, nature: 'integre' as const, outputPaths: [], risk: 'read',
  timeoutMs: 8000, maxBytes: 16384, autonome: false, actif, activeLe: actif ? '2026-10-03T10:00:00.000Z' : null,
  autonomeLe: null, inappelable: null,
});

const fiche = (i: number): FicheConnaissance => ({
  id: `f${i}`, titre: `Fiche ${i}`, corps: `${'x'.repeat(300)}${i}`, source: { type: 'page', url: 'https://exemple.fr/tarifs' },
  sourceUrl: 'https://exemple.fr/tarifs', derniereLectureAt: '2026-10-03T10:00:00.000Z', updatedAt: '2026-10-03T10:00:00.000Z',
});

/** Un Stripe simulé : le prix relu, puis le client et la session créés. Aucun appel ne part. */
class FauxStripe implements TransportStripe {
  private readonly reponses: ReponseStripe[] = [
    { status: 200, json: { id: 'cus_A' } },
    { status: 200, json: { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' } },
  ];
  async post(): Promise<ReponseStripe> {
    const r = this.reponses.shift();
    if (!r) throw new Error('appel non prévu');
    return r;
  }
  async get(url: string): Promise<ReponseStripe> {
    const id = url.slice(url.lastIndexOf('/') + 1);
    return { status: 200, json: { id, unit_amount: id === 'price_100' ? 10_000 : 5_000, currency: 'eur' } };
  }
}

/** Le contexte que le cerveau lit, et sa réponse : le vrai bac à sable, sans réseau (comme `tests/agent-essai.test.ts`). */
const CONTEXTE: ContexteAgentComplet = {
  modele: 'modele-test',
  mentionIa: 'Vous échangez avec un assistant automatique.', mentionIaFrequence: 'session' as const,
  sorties: [{ code: 'fini', label: 'Fini' }],
  contenu: { ...ficheVide(), objectif: 'Aider.' },
  outilsActifs: [],
  plafonds: { maxAppelsOutils: 12, budgetMicroEur: 30_000 },
  contactInconnu: 'tous',
};

interface Options {
  /** Le plafond des opérations coûteuses, par minute. 0 (défaut) le coupe. */
  couteux?: number;
  statut?: AgentComplet['status'];
  fichesConnaissance?: number;
  solde?: number;
  creditInsuffisant?: boolean;
  payeurAutorise?: boolean;
  /** L'agent de Meta est allumé sur l'espace (lot 5, le répondeur). */
  mbaAllume?: boolean;
  /** L'agent IA déjà répondeur de l'espace. */
  repondeurAgentId?: string | null;
  outilsPoses?: OutilComplet[];
  fiches?: FicheConnaissance[];
}

function monter(o: Options = {}) {
  let agent: AgentComplet = {
    id: AG, label: 'Conseiller', status: o.statut ?? 'draft',
    mentionIa: 'Vous échangez avec un assistant automatique.', modele: 'modele-config',
    maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30_000, inactiviteMinutes: 30,
    contactInconnu: 'lecture_seule', contenu: FICHE_COMPLETE, ficheVersion: 4,
  };
  const cap = {
    lectures: [] as string[],
    creations: [] as Array<{ tenant: string; label: string; modele: string }>,
    patches: [] as Array<{ tenant: string; patch: PatchAgent }>,
    historique: [] as LigneHistorique[],
    ajouts: [] as string[],
    activations: [] as Array<{ id: string; par: string }>,
    fichesCreees: [] as Array<{ tenant: string; fiche: FicheAEcrire }>,
    supprimees: [] as string[],
    journal: [] as Array<{ tenant: string; cible: string; acteurId: string | null }>,
    remplacements: [] as Array<{ tenant: string; source: SourceFiche; n: number }>,
    lecturesDeSite: [] as string[],
    debits: [] as Array<{ tenant: string; montant: number; note: string }>,
    payeurs: [] as string[],
    modes: [] as Array<{ tenant: string; mode: ModeTransfert }>,
    oublis: [] as string[],
    allumages: [] as string[],
    vidages: [] as string[],
    /** Chaque réglage écrit : l'agent pour le mode `agent`, le scénario et son délai pour `scenario`, le mode sinon. */
    repondeurs: [] as string[],
  };
  const poses = [...(o.outilsPoses ?? [])];
  /** Les réglages de l'espace qui portent le répondeur : un seul objet, que les deux portes lisent et écrivent. */
  const reglagesRepondeur: {
    mbaEnabled: boolean; repondeurMode: ModeRepondeur; repondeurAgentId: string | null; repondeurWorkflowId: string | null;
    repondeurDelaiScenarioS: number;
  } = {
    mbaEnabled: o.mbaAllume === true,
    repondeurMode: o.repondeurAgentId ? 'agent' : (o.mbaAllume === true ? 'mba' : 'equipe'),
    repondeurAgentId: o.repondeurAgentId ?? null, repondeurWorkflowId: null, repondeurDelaiScenarioS: 86400,
  };

  const gestion: DepsAgentMcp['gestion'] = {
    agents: {
      listToutes: async (t): Promise<AgentResume[]> => {
        cap.lectures.push(t);
        return t === 't1' ? [{ id: AG, label: agent.label, status: agent.status, sorties: agent.contenu.sorties, modele: agent.modele }] : [];
      },
      complet: async (t, id) => (t === 't1' && id === AG ? agent : null),
      create: async (t, label, mentionIa, modele) => {
        cap.creations.push({ tenant: t, label, modele });
        return { ...agent, id: AG_NEUF, label, status: 'draft', mentionIa, modele, contenu: ficheVide(), ficheVersion: 1 };
      },
      patch: async (t, id, patch) => {
        if (t !== 't1' || id !== AG) return null;
        cap.patches.push({ tenant: t, patch });
        const { contenu, ficheVersionAttendue: _v, ...colonnes } = patch;
        agent = { ...agent, ...colonnes, contenu: { ...agent.contenu, ...(contenu ?? {}) }, ficheVersion: agent.ficheVersion + (contenu ? 1 : 0) };
        return agent;
      },
    },
    modeleParDefaut: 'modele-config',
    etatPourLint: async (t, id) => (t === 't1' && id === AG ? {
      fiche: agent.contenu, fichesConnaissance: o.fichesConnaissance ?? 3,
      outilsActifs: 2, handlersActifs: ['chercher_connaissance', 'terminer'], outilsMcpDebranches: [],
    } : null),
    ...(o.creditInsuffisant ? { assurerCleModele: async () => { throw new CreditInsuffisantPourCle(100); } } : {}),
    historique: { ecrire: async (_t, l) => { cap.historique.push(l); } },
    oublierRepondeur: async (_t, id) => {
      cap.oublis.push(id);
      if (reglagesRepondeur.repondeurAgentId !== id) return false;
      reglagesRepondeur.repondeurAgentId = null;
      return true;
    },
    credits: {
      solde: async () => o.solde ?? 1_234_567,
      historique: async () => [{ id: 'm1', deltaMicroEur: 50_000_000, raison: 'achat', jour: null, at: '2026-10-03T09:00:00.000Z', paiementId: 'cs_1', facture: true }],
    },
    modelesProposes: async () => MODELES_CHOISIS.slice(0, 2).map((m) => ({ ...m, prixEntree: 0.1, prixSortie: 0.4 })),
  };

  const connaissance: DepsConnaissance = {
    connaissance: {
      lister: async (t, id) => (t === 't1' && id === AG ? (o.fiches ?? []) : []),
      creer: async (t, id, f) => {
        if (t !== 't1' || id !== AG) return null;
        cap.fichesCreees.push({ tenant: t, fiche: f });
        return { ...fiche(cap.fichesCreees.length), titre: f.titre, corps: f.corps, source: { type: 'manuel' } };
      },
      modifier: async () => null,
      supprimer: async (t, id, ficheId) => {
        if (t !== 't1' || id !== AG) return false;
        cap.supprimees.push(ficheId);
        return true;
      },
      remplacerSource: async (t, id, source, fiches) => {
        if (t !== 't1' || id !== AG) return null;
        cap.remplacements.push({ tenant: t, source, n: fiches.length });
        return { retirees: 0, ecrites: fiches.length };
      },
    },
    journaliserSuppression: async (t, _a, l) => { cap.journal.push({ tenant: t, cible: l.cible, acteurId: l.acteurId }); },
    fetchUrl: async (url) => {
      cap.lecturesDeSite.push(url);
      return { status: 200, contentType: 'text/html', body: '<html><body><h1>Tarifs</h1><p>Le cottage deux personnes coûte 89 euros la nuit, petit-déjeuner compris, toute l’année.</p></body></html>' };
    },
  };

  const cerveau: GatewayBrainDeps = {
    client: {
      completer: async () => ({
        texte: 'Bonjour !', appelsOutils: [], finish: 'stop',
        usage: { tokensIn: 10, tokensOut: 5, tokensCaches: 0, coutDollars: 0.25 }, generationId: null,
      }),
    },
    contexte: async () => CONTEXTE,
    commissionPct: 0,
    outils: {
      catalogue: { byName: async () => null, listActifs: async () => [] },
      journal: { ouvrir: async () => '', clore: async () => {} },
      resolveurs: { mba: creerResolveurSimulation({ connaissance: { chercher: async () => [] } }) },
      sessions: { compterAppel: async () => {} },
      executerGeste: GESTE_MUET,
    },
  };
  const essai: DepsEssai = {
    essais: { lister: async () => [], ecrire: async () => {}, purger: async () => 0 },
    cerveau,
    disponible: true,
    credits: { solde: async () => o.solde ?? 1_234_567 },
    debiter: async (t, montant, note) => { cap.debits.push({ tenant: t, montant, note }); },
  };

  const paiement: DepsPaiement = {
    stripe: {
      cle: 'rk_test_fausse', livemode: false,
      prix: { refill_50: 'price_50', refill_100: 'price_100' },
      transport: new FauxStripe(),
      pageCredit: 'https://console.exemple/parametres/credit',
    },
    clients: { clientDe: async () => null, retenirClient: async (_t, _l, c) => c },
    payeurAutorise: async (userId) => { cap.payeurs.push(userId); return o.payeurAutorise ?? true; },
  };

  const agentIa: DepsAgentMcp = {
    gestion,
    connaissance,
    essai,
    paiement,
    outils: {
      listToutes: async (_t, id) => (id === AG ? poses : []),
      ajouter: async (_t, id, x) => {
        cap.ajouts.push(x.handler);
        if (id !== AG) return null;
        const neuf = outil(x.handler, false);
        poses.push(neuf);
        return neuf;
      },
      activer: async (_t, _a, id, actif, par) => {
        cap.activations.push({ id, par });
        return { ...outil(id.replace(/^id-/, ''), actif), id };
      },
    },
    reglages: {
      get: async () => ({ agentTransfertMode: 'business_hours' }),
      setAgentTransfertMode: async (t, mode) => { cap.modes.push({ tenant: t, mode }); },
    },
    repondeur: {
      agents: { complet: (t, id) => gestion.agents.complet(t, id) },
      scenarios: {
        getById: async (id, t) => (t === 't1' && id === WF_MCP ? { id: WF_MCP, name: 'Bienvenue', graph: { nodes: [{ id: 'n', type: 'tag', position: { x: 0, y: 0 }, data: {} }], edges: [] } } : null),
        listResume: async () => [],
      },
      reglages: {
        get: async () => ({ ...reglagesRepondeur }),
        setRepondeur: async (_t, c) => {
          cap.repondeurs.push(c.mode === 'agent' ? c.agentId : c.mode === 'scenario' ? `${c.workflowId}/${c.delaiS}` : c.mode);
          reglagesRepondeur.repondeurMode = c.mode;
          reglagesRepondeur.repondeurAgentId = c.mode === 'agent' ? c.agentId : null;
          reglagesRepondeur.repondeurWorkflowId = c.mode === 'scenario' ? c.workflowId : null;
        },
      },
      gatewayDisponible: true,
      activation: {
        numeroDuTenant: async () => 'pn1',
        eligible: async () => true,
        ecrireChezMeta: async (t) => { cap.allumages.push(t); },
        ecrireDrapeau: async (_t, enabled) => { reglagesRepondeur.mbaEnabled = enabled; },
      },
      liste: { toutRetirer: async (t) => { cap.vidages.push(t); return { retires: 2, refuses: 0 }; } },
      historique: { ecrire: async (_t, l) => { cap.historique.push(l); } },
      fils: { reprendreLesFilsDeMeta: async () => 0 },
    },
  };

  const mcp: CablageMcp = {
    ...mcpNumeroInerte,
    ...mcpOffreInerte,
    estDesabonne: jamaisDesabonne,
    inbox: {
      ...mcpInerte,
      listConversations: async () => [],
      getConversationContext: async () => null,
      getDerniersMessages: async () => [],
      recordOutbound: async () => {},
    },
    repo: { getTenantPhoneNumberId: async () => null },
    sendReply: async () => 'wamid',
    takeControl: async () => {},
    contacts: {
      query: async () => [],
      findByPhone: async () => null,
      analysesEtResumes: async () => new Map(),
    },
    listerMembres: async () => [],
    ...mcpEtiquettesInertes,
    ...mcpWidgetsInertes,
    agentIa,
  };
  const aucunCompte: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
  const server = buildServer({
    queue: new FakeQueue(),
    auth: { users: aucunCompte, secret: SECRET },
    plafonds: { couteuxParMinute: o.couteux ?? 0, apiParMinute: 100_000, apiParHeure: 100_000 },
    // La connaissance de la console, le MÊME objet : c'est ce qui prouve que le plafond est partagé.
    agentKnowledge: connaissance,
    v1: { apiKeys: new FaussesCles(), oauth: new FauxJetons(), contacts: contactsV1Muets(), mcp },
  });
  return { server, cap, agent: () => agent };
}

type Serveur = ReturnType<typeof monter>['server'];
const entetes = (bearer: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${bearer}` });

async function appeler(server: Serveur, bearer: string, nom: string, args: Record<string, unknown> = {}) {
  const res = await server.inject({
    method: 'POST', url: '/mcp', headers: entetes(bearer),
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: nom, arguments: args } },
  });
  const b = res.json<{ result?: { content?: Array<{ text: string }>; isError?: boolean }; error?: { message: string } }>();
  const texte = b.result?.content?.[0]?.text ?? '';
  return { texte, isError: b.result?.isError === true, erreurRpc: b.error?.message, json: () => JSON.parse(texte) as Record<string, any> };
}

async function lister(server: Serveur, bearer: string): Promise<string[]> {
  const res = await server.inject({ method: 'POST', url: '/mcp', headers: entetes(bearer), payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  return res.json<{ result: { tools: Array<{ name: string }> } }>().result.tools.map((t) => t.name).sort();
}

/** Les outils de la connexion du numéro (lot 3c) exigent aussi une personne : ils ont leur fichier, `tests/mcp-numero.test.ts`. */
const OUTILS_DU_NUMERO = new Set(OUTILS_NUMERO.map((o) => o.nom));
const EXIGENT_PERSONNE = OUTILS.filter((o) => o.exigePersonne === true && !OUTILS_DU_NUMERO.has(o.nom)).map((o) => o.nom);

/** Des arguments valides pour chaque outil de l'agent : ce qu'un appel qui passerait la garde ferait. */
const ARGS: Record<string, Record<string, unknown>> = {
  list_agents: {},
  get_agent: { agent_id: AG },
  create_agent: { label: 'Accueil' },
  update_agent: { agent_id: AG, ton: 'Chaleureux.' },
  set_agent_tools: { agent_id: AG, outils: ['terminer'] },
  activate_agent: { agent_id: AG, active: true },
  test_agent: { agent_id: AG, messages: [{ role: 'user', content: 'Bonjour' }] },
  list_knowledge: { agent_id: AG },
  add_knowledge: { agent_id: AG, fiches: [{ titre: 'Horaires', corps: 'Ouvert de 9 h à 18 h.' }] },
  delete_knowledge: { agent_id: AG, ids: ['44444444-4444-4444-8444-444444444444'] },
  preview_site: { agent_id: AG, url: 'https://exemple.fr/tarifs', portee: 'page' },
  import_site: { agent_id: AG, url: 'https://exemple.fr/tarifs' },
  import_document_text: { agent_id: AG, nom: 'Tarifs.txt', texte: 'Le cottage deux personnes coûte 89 euros la nuit, petit-déjeuner compris, toute l’année.' },
  set_transfer_mode: { mode: 'never' },
  set_default_responder: { agent_id: AG },
  get_credit: {},
  buy_credit: { offre: 'refill_50' },
};

/** Les traces d'écriture et de lecture des dépendances de l'agent, mises bout à bout : vides = rien n'a été touché. */
const touche = (cap: ReturnType<typeof monter>['cap']) => Object.entries(cap).filter(([, v]) => v.length > 0).map(([k]) => k);

describe('🔴 la personne requise : une clé d’API ne voit ni n’appelle les outils qui écrivent au nom de quelqu’un', () => {
  it('dix-sept outils : quatre lectures sans personne, treize outils qui l’exigent (le répondeur compris, lot 5)', () => {
    const agent = OUTILS.filter((o) => Object.hasOwn(ARGS, o.nom));
    expect(agent.map((o) => o.nom).sort()).toEqual(Object.keys(ARGS).sort());
    expect(agent.filter((o) => o.exigePersonne !== true).map((o) => o.nom).sort())
      .toEqual(['get_agent', 'get_credit', 'list_agents', 'list_knowledge']);
    expect(EXIGENT_PERSONNE.sort()).toEqual(agent.filter((o) => o.exigePersonne === true).map((o) => o.nom).sort());
  });

  it('🔴 une clé mcp:write ne les LISTE pas, et leur appel est refusé comme celui d’un outil inconnu, sans rien toucher', async () => {
    const { server, cap } = monter();
    const visibles = await lister(server, CLE_ECRITURE);
    // La clé est bien résolue : elle voit les lectures de l'agent et toutes les écritures qui n'exigent personne.
    expect(visibles).toEqual(OUTILS.filter((o) => o.exigePersonne !== true).map((o) => o.nom).sort());
    expect(visibles).toContain('get_credit');
    const fantome = await appeler(server, CLE_ECRITURE, 'outil_qui_n_existe_pas');
    for (const nom of EXIGENT_PERSONNE) {
      expect(visibles, nom).not.toContain(nom);
      const r = await appeler(server, CLE_ECRITURE, nom, ARGS[nom]);
      expect(r.erreurRpc, nom).toBe(fantome.erreurRpc!.replace('outil_qui_n_existe_pas', nom));
    }
    expect(touche(cap)).toEqual([]);
    await server.close();
  });

  it('un jeton OAuth les voit tous ; un jeton de lecture voit preview_site, et aucune écriture', async () => {
    const { server } = monter();
    expect(await lister(server, JETON.brut)).toEqual(OUTILS.map((o) => o.nom).sort());
    const lecture = await lister(server, JETON_LECTURE.brut);
    expect(lecture).toEqual(OUTILS.filter((o) => o.scope === 'mcp:read').map((o) => o.nom).sort());
    expect(lecture).toContain('preview_site');
    await server.close();
  });
});

describe('🔴 le plafond des opérations coûteuses est celui de la console', () => {
  it('au-delà de sa borne : un refus isError lisible, qui dit quand réessayer, et la fonction n’est pas appelée', async () => {
    const { server, cap } = monter({ couteux: 2 });
    for (let i = 0; i < 2; i++) expect((await appeler(server, JETON.brut, 'add_knowledge', ARGS.add_knowledge)).isError).toBe(false);
    const r = await appeler(server, JETON.brut, 'add_knowledge', ARGS.add_knowledge);
    expect(r.erreurRpc, 'un refus, pas une panne de protocole').toBeUndefined();
    expect(r.isError).toBe(true);
    expect(r.texte).toMatch(new RegExp(`^${MESSAGE_OPERATIONS_LOURDES} \\(réessayer dans \\d+ s\\)$`));
    expect(cap.fichesCreees).toHaveLength(2);
    await server.close();
  });

  it('🔴 MÊME instance, MÊME clé : deux aperçus depuis l’onglet, et le troisième, par Claude, est refusé ; un autre espace garde le sien', async () => {
    const { server, cap } = monter({ couteux: 2 });
    const session = await signSession({ userId: PERSONNE, tenantId: 't1', role: 'admin' }, SECRET);
    for (let i = 0; i < 2; i++) {
      const res = await server.inject({
        method: 'POST', url: `/tenants/t1/agents/${AG}/knowledge/apercu`, headers: entetes(session), payload: { url: 'https://exemple.fr/tarifs' },
      });
      expect(res.statusCode, 'la route de la console passe').toBe(200);
    }
    const parClaude = await appeler(server, JETON.brut, 'preview_site', ARGS.preview_site);
    expect(parClaude.isError).toBe(true);
    expect(parClaude.texte).toContain(MESSAGE_OPERATIONS_LOURDES);
    expect(cap.lecturesDeSite, 'la troisième lecture n’a pas eu lieu').toHaveLength(2);
    // L'espace voisin compte à part : son appel atteint la fonction, qui le refuse pour SON agent inconnu.
    const voisin = await appeler(server, JETON_T2.brut, 'preview_site', ARGS.preview_site);
    expect(voisin.texte).not.toContain(MESSAGE_OPERATIONS_LOURDES);
    await server.close();
  });

  it('chacun des sept outils coûteux le consomme, et aucun autre', async () => {
    const couteux = ['test_agent', 'add_knowledge', 'delete_knowledge', 'preview_site', 'import_site', 'import_document_text', 'buy_credit'];
    for (const nom of Object.keys(ARGS)) {
      const { server, cap } = monter({ couteux: 1 });
      await appeler(server, JETON.brut, nom, ARGS[nom]);
      const avant = JSON.stringify(cap);
      const second = await appeler(server, JETON.brut, nom, ARGS[nom]);
      const refuse = second.texte.includes(MESSAGE_OPERATIONS_LOURDES);
      expect(refuse, nom).toBe(couteux.includes(nom));
      // Le plafond se consomme AVANT la fonction : refusé, l'appel n'a rien débité, rien écrit, rien lu.
      if (refuse) expect(JSON.stringify(cap), `${nom} : rien n'est touché quand le plafond refuse`).toBe(avant);
      await server.close();
    }
  });
});

describe('les outils de l’agent appellent les fonctions de la console, dans l’espace du jeton', () => {
  it('🔴 create_agent : l’espace vient du jeton, jamais des arguments ; ni plafonds ni mention d’IA dans ce qui est rendu', async () => {
    const { server, cap } = monter();
    const r = await appeler(server, JETON.brut, 'create_agent', { label: 'Accueil', tenantId: 't2' });
    expect(r.isError).toBe(false);
    // Le modèle des agents de Claude Code, et non le défaut du serveur (`modele-config`) que garde la console.
    expect(cap.creations).toEqual([{ tenant: 't1', label: 'Accueil', modele: MODELE_AGENT_CLAUDE_CODE }]);
    expect(r.json().agent).toEqual({ id: AG_NEUF, label: 'Accueil', status: 'draft', modele: MODELE_AGENT_CLAUDE_CODE, fiche: ficheVide(), fiche_version: 1 });
    await server.close();
  });

  it('create_agent sans crédit : la phrase de la console, qui dit quoi faire', async () => {
    const { server, cap } = monter({ creditInsuffisant: true });
    const r = await appeler(server, JETON.brut, 'create_agent', { label: 'Accueil' });
    expect(r.isError).toBe(true);
    expect(r.texte).toMatch(/^crédit insuffisant pour créer un agent/);
    expect(cap.creations).toEqual([]);
    await server.close();
  });

  it('🔴 update_agent REFUSE ce que la spec ne lui ouvre pas (plafonds, mention d’IA, libellé, statut, nom), et n’écrit rien', async () => {
    const { server, cap } = monter();
    for (const interdit of [{ maxTours: 20 }, { budgetMicroEur: 100_000_000 }, { mentionIa: 'x' }, { label: 'y' }, { status: 'active' }, { nom: 'Léa' }, { contenu: { objectif: 'z' } }]) {
      const r = await appeler(server, JETON.brut, 'update_agent', { agent_id: AG, ...interdit });
      expect(r.isError, JSON.stringify(interdit)).toBe(true);
      expect(r.texte, JSON.stringify(interdit)).toContain(`champ non modifiable par cet outil : ${Object.keys(interdit)[0]}`);
    }
    expect(cap.patches).toEqual([]);
    await server.close();
  });

  it('🔴 update_agent écrit la fiche, le modèle et le verrou par modifierAgent, et la ligne d’historique est signée « mcp » par la personne', async () => {
    const { server, cap } = monter();
    const modele = MODELES_CHOISIS[1]!.id;
    const sorties = [{ code: 'rdv_pris', label: 'Rendez-vous pris' }];
    const r = await appeler(server, JETON.brut, 'update_agent', { agent_id: AG, ton: 'Chaleureux.', sorties, modele, fiche_version: 4 });
    expect(r.isError, r.texte).toBe(false);
    expect(cap.patches).toEqual([{ tenant: 't1', patch: { contenu: { ton: 'Chaleureux.', sorties }, modele, ficheVersionAttendue: 4 } }]);
    expect(cap.historique).toHaveLength(1);
    expect(cap.historique[0]).toMatchObject({ element: 'fiche_agent', origine: 'mcp', acteurId: PERSONNE, surfaceId: AG });
    expect(r.json().agent).toMatchObject({ fiche_version: 5, modele });
    expect(r.json().agent).not.toHaveProperty('budgetMicroEur');
    await server.close();
  });

  it('update_agent : un modèle hors liste et un agent d’un autre espace sont refusés avec la phrase de la console', async () => {
    const { server, cap } = monter();
    expect((await appeler(server, JETON.brut, 'update_agent', { agent_id: AG, modele: 'openai/gpt-maison' })).texte).toMatch(/^modèle inconnu/);
    expect((await appeler(server, JETON_T2.brut, 'update_agent', { agent_id: AG, ton: 'x' })).texte).toBe('agent introuvable');
    expect(cap.patches).toEqual([]);
    await server.close();
  });

  it('🔴 update_agent qui viderait l’objectif d’un agent ACTIF : refusé, et le refus DIT ce qu’il introduirait', async () => {
    const { server, cap } = monter({ statut: 'active' });
    const r = await appeler(server, JETON.brut, 'update_agent', { agent_id: AG, objectif: '' });
    expect(r.isError).toBe(true);
    expect(r.texte).toContain('agent actif : cette modification le rendrait incomplet');
    expect(r.texte, 'les détails du refus partent avec la phrase').toContain('L’objectif de l’agent est vide');
    expect(cap.patches).toEqual([]);
    await server.close();
  });

  it('🔴 activate_agent : un agent incomplet est refusé AVEC la liste des manques ; complet, il est activé au nom de la personne', async () => {
    const incomplet = monter({ fichesConnaissance: 0 });
    const r = await appeler(incomplet.server, JETON.brut, 'activate_agent', { agent_id: AG, active: true });
    expect(r.isError).toBe(true);
    expect(r.texte).toMatch(/^agent incomplet\n/);
    expect(JSON.parse(r.texte.split('\n')[1]!)).toEqual({
      manques: [{ onglet: 'connaissance', message: 'La base de connaissance est vide : l’agent transférerait toutes les questions de fond.' }],
    });
    expect(incomplet.cap.patches).toEqual([]);
    await incomplet.server.close();

    const complet = monter();
    const ok = await appeler(complet.server, JETON.brut, 'activate_agent', { agent_id: AG, active: true });
    expect(ok.isError, ok.texte).toBe(false);
    expect(ok.json().agent.status).toBe('active');
    expect(complet.cap.historique[0]).toMatchObject({ origine: 'mcp', acteurId: PERSONNE, apres: { status: 'active' } });
    // `active` absent ou mal formé : refusé, plutôt qu'une désactivation silencieuse.
    expect((await appeler(complet.server, JETON.brut, 'activate_agent', { agent_id: AG, active: 'oui' })).isError).toBe(true);
    await complet.server.close();
  });

  it('🔴 set_agent_tools : envoyer_bloc est refusé ; les quatre outils sûrs sont ajoutés et activés au nom de la personne', async () => {
    const { server, cap } = monter({ outilsPoses: [outil('terminer', true)] });
    const refuse = await appeler(server, JETON.brut, 'set_agent_tools', { agent_id: AG, outils: ['chercher_connaissance', 'envoyer_bloc'] });
    expect(refuse.isError).toBe(true);
    expect(refuse.texte).toContain('outils acceptés : terminer, chercher_connaissance, lire_contact, escalader');
    expect(cap.ajouts).toEqual([]);
    const r = await appeler(server, JETON.brut, 'set_agent_tools', { agent_id: AG, outils: ['terminer', 'chercher_connaissance'] });
    expect(r.isError, r.texte).toBe(false);
    expect(cap.ajouts).toEqual(['chercher_connaissance']);
    expect(cap.activations).toEqual([{ id: 'id-chercher_connaissance', par: PERSONNE }]);
    expect(r.json().outils).toEqual([
      { code: 'terminer', nom: 'mba_terminer', actif: true },
      { code: 'chercher_connaissance', nom: 'mba_chercher_connaissance', actif: true },
    ]);
    await server.close();
  });

  it('🔴 test_agent : le vrai bac à sable, débité sous la note du serveur MCP, et le coût rendu en euros', async () => {
    const { server, cap } = monter();
    const r = await appeler(server, JETON.brut, 'test_agent', ARGS.test_agent);
    expect(r.isError, r.texte).toBe(false);
    // Premier message d'une conversation neuve, régime « session » : la phrase d'annonce part devant, posée par le code
    // (2026-10-05). Claude voit ce que le contact recevra.
    expect(r.json()).toMatchObject({ texte: 'Vous échangez avec un assistant automatique.\n\nBonjour !', cout_eur: expect.any(Number) });
    expect(cap.debits).toHaveLength(1);
    expect(cap.debits[0]).toMatchObject({ tenant: 't1', note: 'essai depuis le serveur MCP' });
    expect(r.json().cout_eur).toBe(Math.round(cap.debits[0]!.montant / 10_000) / 100);
    await server.close();
  });

  it('test_agent à solde épuisé : la phrase de la console, et rien n’est débité', async () => {
    const { server, cap } = monter({ solde: 0 });
    const r = await appeler(server, JETON.brut, 'test_agent', ARGS.test_agent);
    expect(r.texte).toBe('solde épuisé : rechargez le compte pour essayer votre agent');
    expect(cap.debits).toEqual([]);
    await server.close();
  });

  it('list_knowledge : un extrait et la provenance, borné, et un agent inconnu est refusé au lieu d’une liste vide', async () => {
    const { server } = monter({ fiches: [fiche(1), fiche(2), fiche(3)] });
    const r = await appeler(server, JETON_LECTURE.brut, 'list_knowledge', { agent_id: AG, limit: 2 });
    expect(r.json()).toMatchObject({ total: 3, tronque: true });
    expect(r.json().fiches[0]).toEqual({
      id: 'f1', titre: 'Fiche 1', extrait: 'x'.repeat(200), caracteres: 301, source: { type: 'page', url: 'https://exemple.fr/tarifs' },
      derniere_lecture: '2026-10-03T10:00:00.000Z',
    });
    expect((await appeler(server, JETON_T2.brut, 'list_knowledge', { agent_id: AG })).texte).toBe('agent introuvable');
    await server.close();
  });

  it('add_knowledge et delete_knowledge : la gestion de la console, et la suppression journalisée au nom de la personne', async () => {
    const { server, cap } = monter();
    const ajout = await appeler(server, JETON.brut, 'add_knowledge', ARGS.add_knowledge);
    expect(ajout.json()).toMatchObject({ ajoutees: 1 });
    expect(cap.fichesCreees).toEqual([{ tenant: 't1', fiche: { titre: 'Horaires', corps: 'Ouvert de 9 h à 18 h.' } }]);
    const trop = await appeler(server, JETON.brut, 'add_knowledge', { agent_id: AG, fiches: Array.from({ length: 51 }, () => ({ titre: 't', corps: 'c' })) });
    expect(trop.texte).toBe('1 à 50 fiches par ajout');
    const suppression = await appeler(server, JETON.brut, 'delete_knowledge', ARGS.delete_knowledge);
    expect(suppression.json()).toEqual({ supprimees: 1, demandees: 1 });
    expect(cap.journal).toEqual([{ tenant: 't1', cible: '44444444-4444-4444-8444-444444444444', acteurId: PERSONNE }]);
    await server.close();
  });

  it('🔴 import_document_text : rangé comme un document, et un caractère nul est refusé avec une phrase lisible', async () => {
    const { server, cap } = monter();
    const r = await appeler(server, JETON.brut, 'import_document_text', ARGS.import_document_text);
    expect(r.isError, r.texte).toBe(false);
    expect(cap.remplacements).toEqual([{ tenant: 't1', source: { type: 'document', nom: 'Tarifs.txt' }, n: 1 }]);
    const nul = await appeler(server, JETON.brut, 'import_document_text', { agent_id: AG, nom: 'b.bin', texte: 'abc\u0000def' });
    expect(nul.erreurRpc, 'un refus, pas une erreur interne').toBeUndefined();
    expect(nul.isError).toBe(true);
    expect(nul.texte).toMatch(/^texte illisible : il contient un caractère nul/);
    expect(cap.remplacements).toHaveLength(1);
    await server.close();
  });

  it('preview_site puis import_site : les gardes d’adresse de la console', async () => {
    const { server, cap } = monter();
    const interne = await appeler(server, JETON.brut, 'preview_site', { agent_id: AG, url: 'http://169.254.169.254/latest/meta-data' });
    expect(interne.texte).toBe('adresse invalide ou non autorisée (http(s) et hôte public attendus)');
    expect(cap.lecturesDeSite).toEqual([]);
    const apercu = await appeler(server, JETON.brut, 'preview_site', ARGS.preview_site);
    expect(apercu.json()).toMatchObject({ portee: 'page', pages: [{ url: 'https://exemple.fr/tarifs', fiches: 1 }] });
    const ailleurs = await appeler(server, JETON.brut, 'import_site', { agent_id: AG, url: 'https://exemple.fr/', pages: ['https://autre-site.fr/'] });
    expect(ailleurs.texte).toBe('aucune adresse importable dans la demande');
    const imp = await appeler(server, JETON.brut, 'import_site', ARGS.import_site);
    expect(imp.json()).toMatchObject({ importees: ['https://exemple.fr/tarifs'], ecrites: 1 });
    expect(cap.remplacements).toEqual([{ tenant: 't1', source: { type: 'page', url: 'https://exemple.fr/tarifs' }, n: 1 }]);
    await server.close();
  });

  it('set_transfer_mode : le réglage de l’espace du jeton, et un mode inconnu est refusé', async () => {
    const { server, cap } = monter();
    expect((await appeler(server, JETON.brut, 'set_transfer_mode', { mode: 'parfois' })).texte).toBe('mode requis (always | business_hours | never)');
    expect((await appeler(server, JETON.brut, 'set_transfer_mode', { mode: 'never' })).json()).toEqual({ mode: 'never' });
    expect(cap.modes).toEqual([{ tenant: 't1', mode: 'never' }]);
    await server.close();
  });

  it('get_credit : le solde et les mouvements en euros', async () => {
    const { server } = monter({ solde: 1_234_567 });
    expect((await appeler(server, CLE_ECRITURE, 'get_credit')).json()).toEqual({
      solde_eur: 1.23,
      mouvements: [{ at: '2026-10-03T09:00:00.000Z', jour: null, raison: 'achat', montant_eur: 50 }],
    });
    await server.close();
  });

  it('🔴 buy_credit : l’adresse de Stripe et le montant HORS TAXE ; le payeur est la personne ; un refus garde son code', async () => {
    const { server, cap } = monter();
    const r = await appeler(server, JETON.brut, 'buy_credit', { offre: 'refill_100' });
    expect(r.json()).toEqual({
      url: 'https://checkout.stripe.com/c/pay/cs_test_1', offre: 'refill_100', montant_ht_eur: 100,
      taxe: 'calculée par Stripe sur la page de paiement, selon le pays et le numéro de TVA saisis',
    });
    expect(cap.payeurs).toEqual([PERSONNE]);
    await server.close();
    const refuse = monter({ payeurAutorise: false });
    const r2 = await appeler(refuse.server, JETON.brut, 'buy_credit', { offre: 'refill_50' });
    expect(r2.texte).toBe('recharge pas encore disponible\n{"code":"recharge_indisponible"}');
    await refuse.server.close();
  });

  it('list_agents et get_agent : les manques comptés et listés, sans plafonds ni mention d’IA', async () => {
    const { server, cap } = monter({ fichesConnaissance: 0, outilsPoses: [outil('terminer', true)] });
    const liste = await appeler(server, CLE_ECRITURE, 'list_agents');
    expect(liste.json()).toEqual({ agents: [{ id: AG, label: 'Conseiller', status: 'draft', nb_manques: 1, repondeur: false }] });
    expect(cap.lectures).toEqual(['t1']);
    const r = (await appeler(server, CLE_ECRITURE, 'get_agent', { agent_id: AG })).json();
    expect(r.agent).toEqual({ id: AG, label: 'Conseiller', status: 'draft', modele: 'modele-config', fiche: FICHE_COMPLETE, fiche_version: 4 });
    expect(r).toMatchObject({ transfer_mode: 'business_hours', connecteurs: 0, fiches_connaissance: 0 });
    expect(r.outils).toEqual([{ code: 'terminer', nom: 'mba_terminer', titre: 'terminer', actif: true }]);
    expect(r.manques).toHaveLength(1);
    expect(r.modeles).toHaveLength(2);
    expect(JSON.stringify(r)).not.toMatch(/budgetMicroEur|maxTours|mentionIa/);
    expect((await appeler(server, JETON_T2.brut, 'get_agent', { agent_id: AG })).texte).toBe('agent introuvable');
    await server.close();
  });
});

describe('🔴 qui répond au client (lot 5, RC6) : set_default_responder et list_agents, par la fonction de la console', () => {
  it('l’ANCIENNE forme { agent_id } désigne un agent ACTIF ; l’agent de Meta n’est plus éteint, mais quitte le rôle (sa liste vidée)', async () => {
    const { server, cap } = monter({ statut: 'active', mbaAllume: true });
    const r = await appeler(server, JETON.brut, 'set_default_responder', { agent_id: AG });
    expect(r.isError, r.texte).toBe(false);
    expect(r.json()).toEqual({
      mode: 'agent', agent_id: AG, workflow_id: null, delai_heures: 24, agent_de_meta_allume: false,
      liste_meta: { retires: 2, refuses: 0 }, repondeur_agent_id: AG,
    });
    // Aucun appel chez Meta : allumé, l'agent de Meta reste disponible, en veille.
    expect(cap.allumages).toEqual([]);
    expect(cap.vidages).toEqual(['t1']);
    expect(cap.repondeurs).toEqual([AG]);
    expect(cap.historique).toMatchObject([{ element: 'repondeur', origine: 'mcp', acteurId: PERSONNE, surfaceId: AG }]);
    // Et list_agents le dit.
    expect((await appeler(server, JETON.brut, 'list_agents')).json().agents).toEqual([
      { id: AG, label: 'Conseiller', status: 'active', nb_manques: 0, repondeur: true },
    ]);
    await server.close();
  });

  it('🔴 un agent en brouillon est refusé, sans rien éteindre ni écrire', async () => {
    const { server, cap } = monter({ statut: 'draft', mbaAllume: true });
    const r = await appeler(server, JETON.brut, 'set_default_responder', { agent_id: AG });
    expect(r.isError).toBe(true);
    expect(r.texte).toMatch(/seul un agent actif peut répondre au client/);
    expect([cap.allumages, cap.vidages, cap.repondeurs]).toEqual([[], [], []]);
    await server.close();
  });

  it('ancienne forme : null = l’équipe quand l’agent de Meta est éteint ; un agent d’un autre espace est inconnu ; rien = refusé', async () => {
    const { server, cap } = monter({ statut: 'active', repondeurAgentId: AG });
    const r = await appeler(server, JETON.brut, 'set_default_responder', { agent_id: null });
    expect(r.json()).toMatchObject({ mode: 'equipe', repondeur_agent_id: null });
    expect(cap.repondeurs).toEqual(['equipe']);
    expect((await appeler(server, JETON_T2.brut, 'set_default_responder', { agent_id: AG })).texte).toBe('agent introuvable');
    expect((await appeler(server, JETON.brut, 'set_default_responder', {})).isError).toBe(true);
    expect(cap.repondeurs).toEqual(['equipe']);
    await server.close();
  });

  it('ancienne forme : null = l’agent de Meta quand il est allumé (en veille derrière l’agent IA)', async () => {
    const { server, cap } = monter({ statut: 'active', repondeurAgentId: AG, mbaAllume: true });
    expect((await appeler(server, JETON.brut, 'set_default_responder', { agent_id: null })).json()).toMatchObject({ mode: 'mba', agent_de_meta_allume: false });
    expect(cap.repondeurs).toEqual(['mba']);
    await server.close();
  });

  it('🔴 les quatre positions : un scénario publié et son délai en heures, l’agent de Meta allumé par le geste, l’équipe ; un mode inconnu est refusé', async () => {
    const { server, cap } = monter({ statut: 'active' });
    const s = await appeler(server, JETON.brut, 'set_default_responder', { mode: 'scenario', workflow_id: WF_MCP, delai_heures: 6 });
    expect(s.isError, s.texte).toBe(false);
    expect(s.json()).toMatchObject({ mode: 'scenario', workflow_id: WF_MCP, delai_heures: 6, repondeur_agent_id: null });
    const m = await appeler(server, JETON.brut, 'set_default_responder', { mode: 'mba' });
    expect(m.json()).toMatchObject({ mode: 'mba', agent_de_meta_allume: true });
    expect(cap.allumages).toEqual(['t1']);
    expect((await appeler(server, JETON.brut, 'set_default_responder', { mode: 'equipe' })).json()).toMatchObject({ mode: 'equipe', liste_meta: { retires: 2, refuses: 0 } });
    expect((await appeler(server, JETON.brut, 'set_default_responder', { mode: 'robot' })).isError).toBe(true);
    expect((await appeler(server, JETON.brut, 'set_default_responder', { mode: 'scenario' })).isError).toBe(true);
    expect((await appeler(server, JETON_T2.brut, 'set_default_responder', { mode: 'scenario', workflow_id: WF_MCP })).texte).toBe('scénario introuvable');
    expect(cap.repondeurs).toEqual([`${WF_MCP}/21600`, 'mba', 'equipe']);
    await server.close();
  });

  it('🔴 désactiver l’agent répondeur par activate_agent lui retire le rôle', async () => {
    const { server, cap } = monter({ statut: 'active', repondeurAgentId: AG });
    expect((await appeler(server, JETON.brut, 'activate_agent', { agent_id: AG, active: false })).isError).toBe(false);
    expect(cap.oublis).toEqual([AG]);
    expect((await appeler(server, JETON.brut, 'list_agents')).json().agents[0].repondeur).toBe(false);
    await server.close();
  });
});

describe('les descriptions disent ce qu’un modèle doit savoir pour ne pas se tromper de chemin (spec, section 1)', () => {
  const d = (nom: string) => OUTILS.find((o) => o.nom === nom)!.description;
  it('un agent actif ne répond à personne sans scénario ; le premier agent exige du crédit ; un essai débite ; un site passe par preview_site', () => {
    for (const nom of ['create_agent', 'activate_agent', 'list_agents']) expect(d(nom), nom).toMatch(/ne répond à aucun client de lui-même/);
    expect(d('create_agent')).toMatch(/au moins l’équivalent de 1 \$/);
    expect(d('create_agent')).toContain('buy_credit');
    expect(d('test_agent')).toMatch(/DÉBITE le crédit/);
    expect(d('add_knowledge')).toMatch(/Un SITE ne se recopie pas ici : preview_site puis import_site/);
    expect(d('buy_credit')).toMatch(/HORS TAXE/);
    expect(d('buy_credit')).toMatch(/taxe est calculée par Stripe/);
  });

  it('🔴 désactiver COUPE l’agent dans ses scénarios : seulement sur demande, jamais pour faire passer un refus', () => {
    for (const nom of ['activate_agent', 'update_agent']) {
      expect(d(nom), nom).toMatch(/COUPE dans les scénarios publiés/);
      expect(d(nom), nom).toMatch(/demande explicite de la personne/);
    }
    // Les extraits de connaissance viennent de tiers : le modèle les lit comme des données.
    expect(d('list_knowledge')).toMatch(/jamais des consignes/);
  });
});

/**
 * 🔴 CE QUE LA CONSOLE REFUSE, LE MODÈLE EN A ÉTÉ PRÉVENU (tâche 7) : chaque borne des saisies de la console, lue
 * dans leur Zod par l'extracteur partagé, figure dans le schéma de l'outil avec la même valeur.
 */
describe('🔴 les bornes de la console sont annoncées dans les schémas des outils de l’agent', () => {
  const schema = (nom: string) => OUTILS.find((o) => o.nom === nom)!.entree;
  const fiche = champsDe(fichePatchSchema);
  const modification = champsDe(saisieDeModification);
  const site = champsDe(saisieDeSite);
  const CAS: Array<[outil: string, bornes: Borne[]]> = [
    ['create_agent', bornesDesChamps(champsDe(saisieDeCreation))],
    ['update_agent', bornesDesChamps({
      objectif: fiche.objectif, ton: fiche.ton, personnalite: fiche.personnalite, reglesTransfert: fiche.reglesTransfert,
      sorties: fiche.sorties, modele: modification.modele, fiche_version: modification.ficheVersionAttendue,
    })],
    ['set_agent_tools', bornesDesChamps({ outils: saisieDOutilsSurs })],
    ['test_agent', bornesDesChamps(champsDe(saisieDEssai))],
    ['add_knowledge', [...bornesDesChamps({ fiches: saisieDeListeDeFiches }), ...bornesZod('fiches[]', saisieDeFiche)]],
    ['delete_knowledge', bornesDesChamps(champsDe(saisieDeSuppression))],
    ['preview_site', bornesDesChamps({ url: site.url, portee: site.portee })],
    ['import_site', bornesDesChamps({ url: site.url, pages: site.pages })],
    ['import_document_text', bornesDesChamps(champsDe(saisieDeTexteDocument))],
    ['buy_credit', bornesDesChamps(champsDe(saisieDePaiement))],
  ];

  it('chaque borne, avec sa valeur', () => {
    const toutes = CAS.flatMap(([, b]) => b);
    expect(toutes.length, 'l’extracteur ne lit plus les bornes de Zod : c’est LUI qu’il faut réparer').toBeGreaterThanOrEqual(35);
    for (const [nom, bornes] of CAS) expect(muettes(bornes, schema(nom)), nom).toEqual([]);
  });

  it('les règles d’arrêt : le motif du code, l’unicité, et le plafond de la liste sont dits', () => {
    const sorties = schema('update_agent').properties.sorties!;
    expect(sorties.items?.properties?.code?.pattern).toBe('^[a-z0-9](?:[a-z0-9_]{0,30}[a-z0-9])?$');
    expect(sorties.description).toMatch(/codes uniques/);
  });

  it('update_agent n’annonce QUE les champs que la spec lui ouvre, et refuse tout autre', () => {
    const s = schema('update_agent');
    expect(Object.keys(s.properties).sort()).toEqual(
      ['agent_id', 'fiche_version', 'modele', 'objectif', 'personnalite', 'reglesTransfert', 'sorties', 'ton'],
    );
    expect(s.additionalProperties).toBe(false);
  });

  it('les modes de transfert annoncés sont ceux que le réglage accepte', () => {
    expect(schema('set_transfer_mode').properties.mode!.enum).toEqual([...MODES_TRANSFERT]);
  });
});
