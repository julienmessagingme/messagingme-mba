import { describe, it, expect, vi, afterEach } from 'vitest';
import { creerChiffrage, type DepsChiffrage, type LotRcs, type StatsDuChiffrage } from '../src/stats/chiffrage';
import { FENETRE_BASCULE_MS } from '../src/stats/rcs-conversationnel';
import { rangeToUnix, addDays, todayParis, type DateRange } from '../src/stats/range';
import { GRILLE_DEFAUT, coutRcsEuros, grilleDepuisLigne } from '../src/stats/prix';
import { estimateCoutParCampagne, type VolumeCampagneRow } from '../src/stats/cost';
import { PLAFOND_TOURS_IA } from '../src/stats/cout-ia';
import type { PricingSummary } from '../src/meta/pricing';
import type { LienTrace } from '../src/links/tracked-links.pg';

/**
 * LE CHIFFRAGE, EXÉCUTÉ (lot 2 de `docs/superpowers/plans/2026-09-27-approfondir-la-racine.md`).
 *
 * 🔴 CE FICHIER REMPLACE DEUX TESTS QUI LISAIENT LA SOURCE, et c'est ce qui le justifie. Le calcul pur
 * (`cost.ts`, `prix.ts`, `rcs-conversationnel.ts`...) était testé ; son APPEL vivait dans la racine de
 * composition, où `tests/prix-cablage.test.ts` et `tests/cout-campagne-rcs-cablage.test.ts` le vérifiaient par
 * expression régulière : la marge oubliée trois fois (en remettant `return brut;`, les 5 683 tests restaient
 * verts), le RCS jamais attribué (`attribuer` absent, toutes les campagnes RCS en case vide), la bascule calculée
 * sur la mauvaise population. L'appel vit désormais dans `src/stats/chiffrage.ts` : on l'EXÉCUTE contre un faux
 * dépôt et un faux tarif, et on lit le CHIFFRE rendu et les arguments reçus.
 *
 * ⚠️ La marge des fixtures vaut 150 et les prix RCS 7 et 11 cts, jamais les défauts (100, 6, 8) : avec un
 * défaut, un chemin qui oublie de lire la grille rendrait le même chiffre que celui qui la lit.
 */

const T = 't1';
const PLAGE: DateRange = { from: '2026-09-01', to: '2026-09-10' };
const LIGNE = {
  prix_marge_template: 150,
  prix_service_centimes: 2.48,
  prix_service_franchise: 1000,
  prix_service_depuis: '2026-10-01',
  prix_rcs_centimes: 7,
  prix_rcs_conv_centimes: 11,
};
const GRILLE = grilleDepuisLigne(LIGNE);

const tarifBrut = (): PricingSummary => ({
  byCategory: {
    marketing: { category: 'marketing', cost: 10, volume: 100, ratePerMessage: 0.1 },
    utility: { category: 'utility', cost: 2, volume: 100, ratePerMessage: 0.02 },
    service: { category: 'service', cost: 0.3, volume: 10, ratePerMessage: 0.03 },
  },
  totalCost: 12.3,
  currency: 'EUR',
});

interface Appel { m: string; args: unknown[] }

/**
 * Un chiffrage monté sur des faux qui RETIENNENT ce qu'on leur demande. Chaque cas ne surcharge que ce dont il
 * parle ; le reste rend le vide.
 */
function monter(o: {
  ligne?: Record<string, unknown> | null;
  waba?: string | null;
  tarif?: () => Promise<PricingSummary | null>;
  stats?: Partial<StatsDuChiffrage>;
  graphe?: unknown;
  bilan?: Awaited<ReturnType<DepsChiffrage['historique']['bilanContact']>>;
  liens?: Partial<DepsChiffrage['liens']>;
  retentionJours?: number;
} = {}) {
  const appels: Appel[] = [];
  const note = (m: string) => (...args: unknown[]) => { appels.push({ m, args }); };
  const tarifs: Array<{ tenant: string; waba: string; startTs: number; endTs: number }> = [];
  const stats: StatsDuChiffrage = {
    grillePrixGlobale: async () => { note('grillePrixGlobale')(); return o.ligne === undefined ? LIGNE : o.ligne; },
    getCostVolume: async (...a) => { note('getCostVolume')(...a); return []; },
    getVolumeParCampagne: async (...a) => { note('getVolumeParCampagne')(...a); return []; },
    serviceParMois: async (...a) => { note('serviceParMois')(...a); return []; },
    envoisEtReactionsRcs: async (...a) => { note('envoisEtReactionsRcs')(...a); return { conversations: [], reactions: [] }; },
    clicsParCampagne: async () => new Map(),
    engagementsParCampagne: async () => new Map(),
    servicesParCampagne: async () => new Map(),
    ficheCampagne: async () => null,
    envoisDeLaCampagne: async () => [],
    getCampaignFunnel: async () => ({
      sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, sansAccuse: 0, buttonReplies: 0, urlClicks: null,
      contactsVises: 0, parCanal: [],
    }),
    mesuresScenarioParCampagne: async (...a) => { note('mesuresScenarioParCampagne')(...a); return []; },
    consommationIa: async (...a) => {
      note('consommationIa')(...a);
      return { coutMicroEur: 0, tokensEntree: 0, tokensSortie: 0, sessions: 0, tours: [], tronque: false };
    },
    ...o.stats,
  };
  const deps: DepsChiffrage = {
    stats,
    waba: { getTenantWabaId: async () => (o.waba === undefined ? 'waba-1' : o.waba) },
    meta: {
      pricingClientForTenant: async (tenant) => {
        note('pricingClientForTenant')(tenant);
        return {
          getPricingAnalytics: async (waba, startTs, endTs) => {
            tarifs.push({ tenant, waba, startTs, endTs });
            return o.tarif ? o.tarif() : tarifBrut();
          },
        };
      },
    },
    historique: { bilanContact: async () => o.bilan ?? null },
    scenarios: { getById: async (...a) => { note('getById')(...a); return { graph: o.graphe ?? { nodes: [] } }; } },
    liens: {
      listByTemplates: async (...a) => { note('listByTemplates')(...a); return []; },
      clicsAttribuesCampagne: async (...a) => { note('clicsAttribuesCampagne')(...a); return { attribues: {}, anonymes: 0 }; },
      codesRcsParDestination: async (...a) => { note('codesRcsParDestination')(...a); return new Map(); },
      countClicks: async (...a) => { note('countClicks')(...a); return {}; },
      ...o.liens,
    },
    evenements: { countByNode: async () => [{ nodeId: 'n1', kind: 'sent', handle: null, count: 9, contacts: 9 }] },
    retentionJours: o.retentionJours ?? 90,
  };
  const argsDe = (m: string): unknown[][] => appels.filter((a) => a.m === m).map((a) => a.args);
  return { chiffrage: creerChiffrage(deps), argsDe, tarifs };
}

/** Une campagne RCS du tableau, sans aucun envoi facturable de template. */
const ligneRcs = (campaignId: string): VolumeCampagneRow => ({
  campaignId, nom: `campagne ${campaignId}`, template: null, canal: 'rcs', category: null, count: 0, envois: 3,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('la marge est BRANCHÉE sur chaque chemin qui rend un prix', () => {
  it('🔴 getPricing rend un PRIX DE VENTE, pas le résumé brut de Meta', async () => {
    const { chiffrage } = monter();
    const p = await chiffrage.getPricing(T, PLAGE);
    // La faute qu'on attrape : `return brut;` à la place de `pricingFacture(...)`.
    expect(p?.byCategory['marketing']?.ratePerMessage).toBeCloseTo(0.15, 6);
    expect(p?.byCategory['utility']?.ratePerMessage).toBeCloseTo(0.03, 6);
    // `cost` et `totalCost` sont les charges réelles facturées par Meta ; le service ne se dérive d'aucun tarif.
    expect(p?.byCategory['marketing']?.cost).toBe(10);
    expect(p?.totalCost).toBe(12.3);
    expect(p?.byCategory['service']?.ratePerMessage).toBe(0.03);
  });

  it('🔴 les tarifs des coûts passent par la marge : 10 marketing + 100 utility = 4,50 € et pas 3,00 €', async () => {
    const { chiffrage } = monter({
      stats: {
        getCostVolume: async () => [
          { date: '2026-09-02', category: 'marketing', count: 10 },
          { date: '2026-09-02', category: 'utility', count: 100 },
        ],
      },
    });
    const s = await chiffrage.getCostSeries(T, PLAGE, {});
    expect(s.total).toBe(4.5);
    expect(s.currency).toBe('EUR');
  });

  it('🔴 la marge n est appliquée QU UNE FOIS sur le coût par campagne et sur le coût des messages', async () => {
    // Un second point d'application donnerait 2,25 € : chaque fonction prise isolément resterait juste.
    const { chiffrage } = monter({
      stats: {
        getVolumeParCampagne: async () => [{ campaignId: 'c1', nom: 'c1', template: 'promo', canal: 'whatsapp', category: 'marketing', count: 10, envois: 10 }],
        getCostVolume: async () => [{ date: '2026-09-02', category: 'marketing', count: 10 }],
      },
    });
    const parCampagne = await chiffrage.getCoutParCampagne(T, PLAGE, { inclureArchivees: false });
    expect(parCampagne.lignes[0]?.cout).toBe(1.5);
    const messages = await chiffrage.getCoutMessages(T, PLAGE);
    expect(messages.templates.marketing).toBe(1.5);
  });

  it('les chemins LISENT la grille : sans ligne, marge 100, le tarif de Meta tel quel', async () => {
    // L'autre sens du premier cas : c'est bien la ligne lue qui fait 0,15, pas une marge écrite ailleurs.
    const { chiffrage } = monter({ ligne: null });
    const p = await chiffrage.getPricing(T, PLAGE);
    expect(p?.byCategory['marketing']?.ratePerMessage).toBe(0.1);
  });

  it('🔴 la marge qui explique l écart, et la grille de /ops, sont celles qui margent les prix', async () => {
    const { chiffrage } = monter();
    expect(await chiffrage.margeTemplate()).toBe(150);
    expect(await chiffrage.grille()).toEqual(GRILLE);
  });

  it('sans WABA, aucun appel à Meta : getPricing rend null et les coûts restent sans tarif', async () => {
    const { chiffrage, tarifs, argsDe } = monter({ waba: null });
    expect(await chiffrage.getPricing(T, PLAGE)).toBeNull();
    const s = await chiffrage.getCostSeries(T, PLAGE, {});
    expect(s.hasRates).toBe(false);
    expect(tarifs).toEqual([]);
    expect(argsDe('pricingClientForTenant')).toEqual([]);
  });
});

describe('le RCS dans le coût par campagne et dans le coût des messages', () => {
  /** Un magasin qui se comporte comme le vrai : sans `attribuer`, `campaignId` vaut `null` partout. */
  const magasinRcs = (lot: LotRcs): Partial<StatsDuChiffrage> => ({
    envoisEtReactionsRcs: async (_t, _r, _f, opts) => ({
      conversations: lot.conversations.map((c) => ({ ...c, campaignId: opts?.attribuer === true ? c.campaignId : null })),
      reactions: lot.reactions,
    }),
  });

  it('🔴 le coût par campagne DEMANDE le rattachement des RCS, et la campagne RCS a un coût', async () => {
    // ⚠️ `attribuer: true` n'est pas décoratif : sans lui, le magasin rend `campaignId: null` partout (défaut
    // le moins cher) et TOUTES les campagnes RCS retombent à une case vide.
    const vu: unknown[][] = [];
    const lot: LotRcs = {
      conversations: [{ conversationId: 'cv1', campaignId: 'c-rcs', waId: '336', envois: 3, instants: ['2026-09-02T10:00:00Z', '2026-09-02T10:01:00Z', '2026-09-02T10:02:00Z'] }],
      reactions: [],
    };
    const { chiffrage } = monter({
      stats: {
        getVolumeParCampagne: async () => [ligneRcs('c-rcs')],
        envoisEtReactionsRcs: async (...a) => { vu.push(a); return magasinRcs(lot).envoisEtReactionsRcs!(...a); },
      },
    });
    const r = await chiffrage.getCoutParCampagne(T, PLAGE, { inclureArchivees: false });
    expect(vu).toEqual([[T, PLAGE, FENETRE_BASCULE_MS, { attribuer: true }]]);
    // Trois RCS simples au prix de la grille (7 cts), pas une case vide.
    expect(r.lignes[0]?.cout).toBe(0.21);
  });

  it('🔴 le coût des MESSAGES ne paie PAS l attribution : la colonne serait jetée', async () => {
    // Une sous-requête corrélée par message RCS, sans index, et la page de synthèse appelle les DEUX routes.
    const { chiffrage, argsDe } = monter();
    await chiffrage.getCoutMessages(T, PLAGE);
    expect(argsDe('envoisEtReactionsRcs')).toEqual([[T, PLAGE, FENETRE_BASCULE_MS]]);
  });

  it('🔴 la BASCULE se calcule sur TOUS les envois de l échange, pas sur ceux de la campagne', async () => {
    // L'échange cv1 porte un RCS de campagne le 2, puis un RCS hors campagne le 12, auquel le contact répond
    // une heure plus tard. La réaction tombe hors de la fenêtre du premier envoi, dans celle du second :
    // l'échange ENTIER bascule, RCS de campagne compris. Filtrer sur la campagne avant la bascule le
    // facturerait au tarif simple, en silence.
    const lot: LotRcs = {
      conversations: [
        { conversationId: 'cv1', campaignId: 'c-rcs', waId: '336', envois: 1, instants: ['2026-09-02T10:00:00Z'] },
        { conversationId: 'cv1', campaignId: null, waId: '336', envois: 1, instants: ['2026-09-12T10:00:00Z'] },
      ],
      reactions: [{ waId: '336', at: '2026-09-12T11:00:00Z' }],
    };
    const { chiffrage } = monter({
      stats: { getVolumeParCampagne: async () => [ligneRcs('c-rcs')], ...magasinRcs(lot) },
    });
    const r = await chiffrage.getCoutParCampagne(T, PLAGE, { inclureArchivees: false });
    // Un RCS conversationnel à 11 cts, et la ligne hors campagne n'est imputée à personne.
    expect(r.lignes[0]?.cout).toBe(0.11);
    expect(r.lignes).toHaveLength(1);
  });

  it('🔴 le coût des messages sépare simples et conversationnels, aux prix de la grille', async () => {
    const lot: LotRcs = {
      conversations: [
        // Réponse dans les sept jours : les TROIS envois de l'échange passent au tarif haut.
        { conversationId: 'cvA', campaignId: null, waId: '33A', envois: 3, instants: ['2026-09-02T10:00:00Z', '2026-09-03T10:00:00Z', '2026-09-04T10:00:00Z'] },
        // Aucune réaction : simple.
        { conversationId: 'cvB', campaignId: null, waId: '33B', envois: 2, instants: ['2026-09-02T10:00:00Z', '2026-09-05T10:00:00Z'] },
      ],
      // La réaction de B est d'un autre numéro que A : le rapprochement se fait par numéro.
      reactions: [{ waId: '33A', at: '2026-09-02T12:00:00Z' }],
    };
    const { chiffrage } = monter({ stats: magasinRcs(lot) });
    const r = await chiffrage.getCoutMessages(T, PLAGE);
    expect(r.rcs).toEqual({ simple: 2, conversationnel: 3, cout: coutRcsEuros(2, 3, GRILLE) });
    expect(r.rcs.cout).toBe(0.47);
  });

  it('les deux écrans appliquent LA MÊME formule de prix RCS', () => {
    // `coutRcsEuros` vit dans `prix.ts` et sert la ligne « coût des messages » comme le tableau.
    expect(coutRcsEuros(1, 2, GRILLE_DEFAUT)).toBeCloseTo(0.22, 6);
    expect(coutRcsEuros(0, 0, GRILLE_DEFAUT)).toBe(0);
  });

  it('🔴 sans lot de RCS, le calcul pur rend EXACTEMENT ce qu il rendait avant', () => {
    // Le paramètre est optionnel, et c'est voulu : une instance qui ne sait pas encore rattacher ses RCS
    // doit laisser la case vide, jamais afficher un zéro qui se lirait « gratuit ».
    const rcs = { campaignId: 'rc', nom: 'gr sentis', template: null, canal: 'rcs', category: null, count: 0, envois: 1 };
    const r = estimateCoutParCampagne([rcs], { marketing: 0.1431, utility: 0.05, currency: 'EUR' }, new Map(), new Map());
    expect(r.lignes[0]!.cout).toBeNull();
  });

  it('la rétention d instance voyage jusqu au magasin, avec le choix des archivées', async () => {
    const { chiffrage, argsDe } = monter({ retentionJours: 45 });
    await chiffrage.getCoutParCampagne(T, PLAGE, { inclureArchivees: true });
    expect(argsDe('getVolumeParCampagne')).toEqual([[T, PLAGE, { inclureArchivees: true, retentionJours: 45 }]]);
  });
});

describe('le tarif de Meta sous micro-cache', () => {
  it('🔴 deux lectures, un seul aller-retour, et getPricing partage le MÊME cache que les coûts', async () => {
    // Quatre écrans le déclenchent, dont l'onglet Campagnes ouvert en permanence : une API tierce à quota.
    const { chiffrage, tarifs } = monter();
    await chiffrage.getCostSeries(T, PLAGE, {});
    await chiffrage.getCoutMessages(T, PLAGE);
    await chiffrage.getPricing(T, PLAGE);
    expect(tarifs).toHaveLength(1);
    const { startTs, endTs } = rangeToUnix(PLAGE);
    expect(tarifs[0]).toEqual({ tenant: T, waba: 'waba-1', startTs, endTs });
  });

  it('🔴 la clé porte l espace ET la fenêtre', async () => {
    const { chiffrage, tarifs } = monter();
    await chiffrage.getPricing('t1', PLAGE);
    await chiffrage.getPricing('t2', PLAGE);
    await chiffrage.getPricing('t1', { from: '2026-08-01', to: '2026-08-31' });
    expect(tarifs.map((t) => t.tenant)).toEqual(['t1', 't2', 't1']);
  });

  it('🔴 un ÉCHEC de Meta (null) est oublié : on retente, on ne le ressert pas une minute', async () => {
    const { chiffrage, tarifs } = monter({ tarif: async () => null });
    expect(await chiffrage.getPricing(T, PLAGE)).toBeNull();
    expect(await chiffrage.getPricing(T, PLAGE)).toBeNull();
    expect(tarifs).toHaveLength(2);
  });

  it('le cache MUTUALISE les appels simultanés : vingt-cinq onglets, un aller-retour', async () => {
    let appels = 0;
    const { chiffrage } = monter({
      tarif: async () => { appels += 1; await new Promise((r) => setTimeout(r, 5)); return tarifBrut(); },
    });
    await Promise.all(Array.from({ length: 25 }, () => chiffrage.getPricing(T, PLAGE)));
    expect(appels).toBe(1);
  });

  it('une durée de vie de soixante secondes, pas davantage', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-20T10:00:00Z'));
    const { chiffrage, tarifs } = monter();
    await chiffrage.getPricing(T, PLAGE);
    vi.setSystemTime(new Date('2026-09-20T10:00:59.900Z'));
    await chiffrage.getPricing(T, PLAGE);
    expect(tarifs, 'encore frais à 59,9 s').toHaveLength(1);
    vi.setSystemTime(new Date('2026-09-20T10:01:00.100Z'));
    await chiffrage.getPricing(T, PLAGE);
    expect(tarifs, 'relu après 60 s').toHaveLength(2);
  });
});

describe('les clics attribués : un seul montage pour la fiche de campagne et les mesures d un scénario', () => {
  const GRAPHE = {
    nodes: [
      { id: 'n1', type: 'template', data: { templateName: 'promo', language: 'fr' } },
      { id: 'n2', type: 'rcs_message', data: { suggestions: [{ kind: 'openUrl', url: 'https://exemple.fr/offre' }] } },
    ],
  };
  const LIEN: LienTrace = {
    code: 'k1', templateName: 'promo', templateLanguage: 'fr', cardIndex: null, buttonIndex: 0,
    destination: 'https://exemple.fr/promo', avecJeton: true,
  };
  const fiche = { id: 'c1', nom: 'Rentrée', template: null, workflowId: 'wf1' };

  it('🔴 la fiche d une campagne compte les clics ATTRIBUÉS à cette campagne, bloc par bloc', async () => {
    const attribues: unknown[][] = [];
    const { chiffrage, argsDe } = monter({
      graphe: GRAPHE,
      stats: { ficheCampagne: async () => fiche },
      liens: {
        listByTemplates: async (_t, noms) => (noms.includes('promo') ? [LIEN] : []),
        // Les clics de CETTE campagne, pas ceux de la période : c'est l'attribution qui fait la fiche.
        clicsAttribuesCampagne: async (...a) => { attribues.push(a); return { attribues: { k1: 4 }, anonymes: 2 }; },
      },
    });
    const d = await chiffrage.getDetailCoutCampagne(T, 'c1');
    expect(d?.etapes.find((e) => e.nodeId === 'n1')?.liens.gestes).toBe(4);
    expect(d?.clicsAnonymes).toBe(2);
    expect(attribues).toEqual([[T, 'c1', ['k1']]]);
    expect(argsDe('getById')).toEqual([['wf1', T]]);
    expect(argsDe('mesuresScenarioParCampagne')).toEqual([[T, 'c1']]);
  });

  it('une campagne sans scénario ne lit ni graphe ni liens ; une campagne inconnue ne paie rien', async () => {
    const direct = monter({ stats: { ficheCampagne: async () => ({ ...fiche, workflowId: null }) } });
    const d = await direct.chiffrage.getDetailCoutCampagne(T, 'c1');
    expect(d?.clicsAnonymes).toBe(0);
    expect(direct.argsDe('getById')).toEqual([]);
    expect(direct.argsDe('mesuresScenarioParCampagne')).toEqual([]);

    const inconnue = monter();
    expect(await inconnue.chiffrage.getDetailCoutCampagne(T, 'c1')).toBeNull();
    expect(inconnue.tarifs).toEqual([]);
  });

  it('un scénario sans bloc template ne lit ni liens ni clics attribués', async () => {
    const { chiffrage, argsDe } = monter({
      graphe: { nodes: [{ id: 'x', type: 'message', data: {} }] },
      stats: { ficheCampagne: async () => fiche },
    });
    const d = await chiffrage.getDetailCoutCampagne(T, 'c1');
    expect(d?.clicsAnonymes).toBe(0);
    expect(argsDe('listByTemplates')).toEqual([]);
    expect(argsDe('clicsAttribuesCampagne')).toEqual([]);
  });

  it('best-effort : une panne des liens retire la colonne, pas la fiche', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { chiffrage } = monter({
      graphe: GRAPHE,
      stats: { ficheCampagne: async () => fiche },
      liens: { listByTemplates: async () => { throw new Error('base indisponible'); } },
    });
    const d = await chiffrage.getDetailCoutCampagne(T, 'c1');
    expect(d?.campaignId).toBe('c1');
    expect(d?.etapes).toEqual([]);
  });

  it('🔴 les mesures d un scénario fusionnent événements, clics de template et clics RCS', async () => {
    const comptes: unknown[][] = [];
    const { chiffrage } = monter({
      graphe: GRAPHE,
      liens: {
        listByTemplates: async () => [LIEN],
        codesRcsParDestination: async () => new Map([['https://exemple.fr/offre', 'r1']]),
        countClicks: async (...a) => { comptes.push(a); return { k1: 3, r1: 5 }; },
      },
    });
    const m = await chiffrage.getWorkflowNodeCounts(T, 'wf1', PLAGE);
    expect(m).toEqual([
      { nodeId: 'n1', kind: 'sent', handle: null, count: 9, contacts: 9 },
      { nodeId: 'n1', kind: 'url_click', handle: 'btn:0', count: 3, contacts: null },
      { nodeId: 'n2', kind: 'url_click', handle: 'lien:0', count: 5, contacts: null },
    ]);
    expect(comptes).toEqual([[T, ['k1', 'r1'], PLAGE]]);
  });

  it('un scénario sans bloc à lien rend ses événements sans rien lire de plus', async () => {
    const { chiffrage, argsDe } = monter({ graphe: { nodes: [{ id: 'x', type: 'message', data: {} }] } });
    const m = await chiffrage.getWorkflowNodeCounts(T, 'wf1', PLAGE);
    expect(m).toHaveLength(1);
    expect(argsDe('listByTemplates')).toEqual([]);
    expect(argsDe('countClicks')).toEqual([]);
  });
});

describe('la fiche de campagne et le bilan d un contact lisent le tarif des trente derniers jours', () => {
  it('🔴 même fenêtre, même marge : un contact se compare à sa campagne', async () => {
    const trente = rangeToUnix({ from: addDays(todayParis(), -29), to: todayParis() });
    const m = monter({
      stats: {
        ficheCampagne: async () => ({ id: 'c1', nom: 'c', template: 'promo', workflowId: null }),
        envoisDeLaCampagne: async () => [{ category: 'marketing', total: 10, lancement: 10 }],
      },
      bilan: { envois: [{ category: 'marketing', count: 2 }], profondeurs: [1] },
    });
    const detail = await m.chiffrage.getDetailCoutCampagne(T, 'c1');
    const bilan = await m.chiffrage.getBilanContact(T, 'ct1');
    expect(detail?.lancement.cout).toBe(1.5);
    expect(bilan?.cout.cout).toBe(0.3);
    // Les deux lectures sont tombées sur la même fenêtre, donc sur la même entrée de cache.
    expect(m.tarifs).toEqual([{ tenant: T, waba: 'waba-1', startTs: trente.startTs, endTs: trente.endTs }]);
  });

  it('un contact inconnu rend null sans appeler Meta', async () => {
    const { chiffrage, tarifs } = monter();
    expect(await chiffrage.getBilanContact(T, 'inconnu')).toBeNull();
    expect(tarifs).toEqual([]);
  });
});

describe('la dépense IA', () => {
  it('lit la consommation sous le plafond de tours de l écran', async () => {
    const { chiffrage, argsDe } = monter();
    await chiffrage.getCoutIa(T, PLAGE);
    expect(argsDe('consommationIa')).toEqual([[T, PLAGE, PLAFOND_TOURS_IA]]);
  });
});
