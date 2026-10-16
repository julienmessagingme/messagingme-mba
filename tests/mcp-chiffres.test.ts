import { describe, it, expect } from 'vitest';
import { OUTILS_CHIFFRES, aLaMaille, cleDeMaille, lirePeriode, type DepsChiffresMcp } from '../src/mcp/outils-chiffres';
import { RefusOutil } from '../src/mcp/saisie';
import { addDays, todayParis } from '../src/stats/range';
import { DROITS } from '../src/offres/offres';
import { adresseOffre } from '../src/offres/refus';
import type { DepsMcp } from '../src/mcp/outils';
import type { StatutsModelesJour } from '../src/stats/store.pg';
import { mcpChiffresInertes } from './routes-inertes';

const INERTES = mcpChiffresInertes.chiffres;
/** Appelle un outil de chiffres sur un espace de l'offre donnée, avec les dépendances données (le reste inerte). */
function appelerOutil(nom: string, chiffres: Omit<Partial<DepsChiffresMcp>, 'stats'> & { stats?: Partial<DepsChiffresMcp['stats']> }, offre: 'base' | 'pro' = 'pro') {
  const deps = {
    offres: { offreDe: async () => ({ offre, droits: DROITS[offre], retourEnBaseLe: null }) },
    chiffres: { ...INERTES, ...chiffres, stats: { ...INERTES.stats, ...chiffres.stats } },
  } as unknown as DepsMcp;
  const o = OUTILS_CHIFFRES.find((x) => x.nom === nom)!;
  return (args: Record<string, unknown> = {}) => o.executer(deps, 't1', args, null) as Promise<Record<string, any>>;
}

/**
 * LES CHIFFRES DE L'ESPACE POUR CLAUDE CODE (plan docs/superpowers/plans/2026-10-13-donnees-graphiques-mcp.md,
 * livraison A) : la période et la maille, le regroupement, et `get_message_stats` selon l'offre.
 */
const outil = OUTILS_CHIFFRES.find((o) => o.nom === 'get_message_stats')!;

describe('la maille', () => {
  it('un jour, le lundi de sa semaine (le dimanche compris), son mois', () => {
    expect(cleDeMaille('2026-10-13', 'jour')).toBe('2026-10-13');
    expect(cleDeMaille('2026-10-13', 'semaine')).toBe('2026-10-12'); // un mardi
    expect(cleDeMaille('2026-10-12', 'semaine')).toBe('2026-10-12'); // un lundi
    expect(cleDeMaille('2026-10-18', 'semaine')).toBe('2026-10-12'); // un dimanche
    expect(cleDeMaille('2026-10-13', 'mois')).toBe('2026-10');
  });

  it('🔴 les sommes se regroupent, la série est dense, un stock garde la valeur du dernier jour', () => {
    const range = { from: '2026-09-28', to: '2026-10-06' };
    const envois = [{ date: '2026-09-28', count: 2 }, { date: '2026-10-04', count: 3 }, { date: '2026-10-06', count: 5 }];
    const contacts = [{ date: '2026-10-04', count: 10 }, { date: '2026-10-05', count: 12 }, { date: '2026-10-06', count: 13 }];
    expect(aLaMaille(range, 'semaine', { envois }, { contacts })).toEqual([
      // Le 4 octobre est un dimanche : il ferme la semaine du 28 septembre, dont le stock est donc 10.
      { periode: '2026-09-28', envois: 5, contacts: 10 },
      { periode: '2026-10-05', envois: 5, contacts: 13 },
    ]);
    expect(aLaMaille(range, 'mois', { envois })).toEqual([
      { periode: '2026-09', envois: 2 },
      { periode: '2026-10', envois: 8 },
    ]);
    // Dense : un jour sans donnée vaut 0, jamais une ligne absente.
    const jours = aLaMaille({ from: '2026-10-01', to: '2026-10-03' }, 'jour', { envois: [{ date: '2026-10-02', count: 1 }] });
    expect(jours).toEqual([
      { periode: '2026-10-01', envois: 0 }, { periode: '2026-10-02', envois: 1 }, { periode: '2026-10-03', envois: 0 },
    ]);
  });
});

describe('la période', () => {
  it('par défaut les 30 derniers jours, au jour ; une maille ou une période mal formée dit quoi corriger', () => {
    const aujourdhui = todayParis();
    expect(lirePeriode({})).toEqual({ range: { from: addDays(aujourdhui, -29), to: aujourdhui }, maille: 'jour' });
    expect(() => lirePeriode({ maille: 'heure' })).toThrow(/maille : jour, semaine, mois/);
    expect(() => lirePeriode({ du: '2026-10-01' })).toThrow(/du et au doivent être fournis ensemble/);
    expect(() => lirePeriode({ du: '2026-10-05', au: '2026-10-01' })).toThrow(RefusOutil);
    expect(() => lirePeriode({ du: '2024-01-01', au: '2026-01-01' })).toThrow(/366 jours/);
  });

  it('🔴 la maille jour est bornée (la réponse doit tenir dans un modèle) ; absente, la semaine au-delà de la borne', () => {
    const au = todayParis();
    const long = { du: addDays(au, -120), au };
    expect(() => lirePeriode({ ...long, maille: 'jour' })).toThrow(/92 jours au plus/);
    expect(lirePeriode(long).maille).toBe('semaine');
    expect(lirePeriode({ du: addDays(au, -91), au }).maille).toBe('jour');
  });
});

describe('get_message_stats selon l’offre', () => {
  function monter(offre: 'base' | 'pro', statuts: StatutsModelesJour[] = []) {
    const appels: string[] = [];
    const chiffres: DepsChiffresMcp = {
      ...INERTES,
      stats: {
        ...INERTES.stats,
        statutsDesModelesParJour: async (t, r) => { appels.push(`statuts:${t}:${r.from}:${r.to}`); return statuts; },
        getDashboard: async (t) => {
          appels.push(`tableau:${t}`);
          return {
            contacts: [{ date: todayParis(), count: 40 }], contactsActifs: [{ date: todayParis(), count: 38 }],
            templates: { utility: [{ date: todayParis(), count: 2 }], marketing: [{ date: todayParis(), count: 5 }] },
            exchanged: [], service: [],
            serviceParOrigine: { ia: 3, scenario: 1, humain: 2, indeterminee: 0 }, serviceIaDetail: { agent: 3, mba: 0, mcp: 0 },
          };
        },
      },
      getCostSeries: async () => ({
        marketing: [{ date: todayParis(), count: 0.123456 }], utility: [], total: 0.12, hasRates: true, currency: 'EUR',
        nonChiffrables: 0, sansCategorie: 0, sansTarif: 0,
      }),
      getCoutMessages: async () => ({
        templates: { marketing: 0.12, utility: 0 }, service: { envoyes: 0, factures: 0, cout: 0, parMois: [] },
        rcs: { simple: 0, conversationnel: 0, cout: 0 }, total: 0.12, currency: 'EUR', nonChiffrables: 0, sansCategorie: 0, sansTarif: 0,
      }),
    };
    const deps = { offres: { offreDe: async () => ({ offre, droits: DROITS[offre], retourEnBaseLe: null }) }, chiffres } as unknown as DepsMcp;
    return { appeler: (args: Record<string, unknown> = {}) => outil.executer(deps, 't1', args, null), appels };
  }
  const jour = todayParis();
  const STATUTS: StatutsModelesJour[] = [{ date: jour, envoyes: 7, livres: 4, lus: 2, echecs: 2, sansAccuse: 2 }];

  it('🔴 Free : l’essentiel seulement (envoyés, livrés, lus, échecs, sans accusé), sans toucher au reste', async () => {
    const { appeler, appels } = monter('base', STATUTS);
    const r = await appeler() as Record<string, unknown>;
    expect(r.detail).toBe('essentiel');
    expect(r.modeles).toMatchObject({ totaux: { envoyes: 7, livres: 4, lus: 2, echecs: 2, sans_accuse: 2 } });
    for (const cle of ['modeles_par_categorie', 'messages', 'contacts', 'cout_estime', 'service_par_origine']) expect(r).not.toHaveProperty(cle);
    expect(appels.some((a) => a.startsWith('tableau:'))).toBe(false);
  });

  it('🔴 Free : une période qui commence avant les 30 derniers jours est refusée avec le lien de l’offre, sans rien lire', async () => {
    const { appeler, appels } = monter('base');
    const du = addDays(jour, -DROITS.base.limites.conservationJours);
    await expect(appeler({ du, au: jour })).rejects.toThrow(adresseOffre());
    await expect(appeler({ du, au: jour })).rejects.toThrow(/30 derniers jours/);
    expect(appels).toEqual([]);
    // Le premier jour permis passe.
    await expect(appeler({ du: addDays(jour, -(DROITS.base.limites.conservationJours - 1)), au: jour })).resolves.toBeDefined();
  });

  it('🔴 Pro : tout, le coût marqué estimation et arrondi au centime, les contacts en stock', async () => {
    const { appeler } = monter('pro', STATUTS);
    const r = await appeler({ du: addDays(jour, -60), au: jour, maille: 'mois' }) as Record<string, any>;
    expect(r.detail).toBe('complet');
    expect(r.modeles.totaux.envoyes).toBe(7);
    expect(r.cout_estime.estimation).toBe(true);
    expect(r.cout_estime.devise).toBe('EUR');
    expect(r.cout_estime.series.at(-1).marketing).toBe(0.12);
    expect(r.contacts.at(-1)).toMatchObject({ cumules: 40, actifs: 38 });
    expect(r.service_par_origine).toEqual({ ia: 3, scenario: 1, humain: 2, indeterminee: 0 });
    expect(r.periode).toEqual({ du: addDays(jour, -60), au: jour, maille: 'mois', fuseau: 'Europe/Paris' });
  });
});

describe('get_campaign_stats', () => {
  it('🔴 sans campagne : la liste de la période, coût arrondi et estimé, et les erreurs regroupées par code puis modèle', async () => {
    const appeler = appelerOutil('get_campaign_stats', {
      getCoutParCampagne: async () => ({
        lignes: [{
          campaignId: 'c1', nom: 'Rentrée', template: 'promo', envoyes: 100, envois: 120, cout: 7.123456, nonChiffrables: 0,
          sansCategorie: 0, sansTarif: 0, clics: 12, coutParClic: 0.5936, engagements: 20, coutParEngagement: 0.356,
        }],
        tronque: false, currency: 'EUR', hasRates: true,
      }),
      stats: {
        getErrorBreakdown: async () => [
          { code: 131026, count: 3, templateName: 'promo', campaignId: 'c1', campaignName: 'Rentrée' },
          { code: 131026, count: 2, templateName: 'promo', campaignId: 'c2', campaignName: 'Soldes' },
          { code: 131049, count: 9, templateName: 'relance', campaignId: 'c2', campaignName: 'Soldes' },
          // Une campagne RCS : un nom de modèle vide.
          { code: 131049, count: 1, templateName: '', campaignId: 'c3', campaignName: 'RCS' },
        ],
      },
    });
    const r = await appeler();
    expect(r.campagnes).toEqual([{
      // envoyes : la colonne « Envoyés » de la console ; un coût unitaire sous l'euro garde quatre décimales.
      campaign_id: 'c1', nom: 'Rentrée', modele: 'promo', envoyes: 120, envois_facturables: 100, cout_estime: 7.12, clics: 12,
      cout_par_clic: 0.5936, engagements: 20, cout_par_engagement: 0.356,
    }]);
    expect(r.erreurs).toEqual([
      { code: 131049, total: 10, par_modele: [{ modele: 'relance', n: 9 }, { modele: '(sans modèle)', n: 1 }] },
      { code: 131026, total: 5, par_modele: [{ modele: 'promo', n: 5 }] },
    ]);
  });

  it('🔴 avec une campagne : son entonnoir ; une campagne inconnue de l’espace est refusée sans lire l’entonnoir', async () => {
    let lus = 0;
    const funnel = {
      sent: 10, delivered: 9, read: 6, replied: 2, failed: 1, sansAccuse: 0, buttonReplies: 1, urlClicks: 3, contactsVises: 11,
      parCanal: [],
    };
    const fiche = { id: '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b', nom: 'Rentrée', template: 'promo', workflowId: null };
    const appeler = appelerOutil('get_campaign_stats', {
      stats: {
        ficheCampagne: async (_t, id) => (id === fiche.id ? fiche : null),
        getCampaignFunnel: async () => { lus += 1; return funnel; },
      },
    });
    const r = await appeler({ campaign_id: fiche.id });
    expect(r.entonnoir).toEqual({
      envoyes: 10, livres: 9, lus: 6, reponses: 2, reponses_boutons: 1, clics: 3, echecs: 1, sans_accuse: 0, contacts_vises: 11,
    });
    expect(r.campagne).toEqual({ id: fiche.id, nom: 'Rentrée', modele: 'promo', scenario: false });
    await expect(appeler({ campaign_id: '11111111-1111-4111-8111-111111111111' })).rejects.toThrow(/campagne introuvable/);
    await expect(appeler({ campaign_id: 'pas-un-uuid' })).rejects.toThrow(/campagne introuvable/);
    expect(lus).toBe(1);
  });
});

describe('get_conversation_insights', () => {
  it('🔴 la satisfaction se re-agrège par la somme et le nombre de mesures, jamais en moyenne de moyennes', async () => {
    const appeler = appelerOutil('get_conversation_insights', {
      conversationStats: {
        getSummary: async () => ({
          enabled: true, retentionDays: 90, total: 10, sentiment: { positif: 5, neutre: 3, negatif: 2 }, intent: {} as never,
          resolution: { resolved: 7, unresolved: 3, rate: 0.7 }, handledBy: { humain: 4, automatise: 5, mba: 1 },
          exchanges: { avg: 6, median: 5 }, actions: { creer_devis: 1, rappeler: 2, relancer: 0, escalader: 1, aucune: 6 },
          topTopics: [{ topic: 'livraison', count: 4 }], topicsParIntention: {},
          confidence: { lt50: 0, from50to70: 1, from70to90: 4, gte90: 5 },
        }),
        // Deux jours d'une même semaine : 1 mesure de 9, puis 9 mesures de 3 : la moyenne juste est 3,6, pas 6.
        joursAnalyse: async () => [
          { jour: '2026-10-05', conversations: 2, satisfaction: 9, urgence: 2, mesurees: 1 },
          { jour: '2026-10-06', conversations: 12, satisfaction: 3, urgence: 4, mesurees: 9 },
        ],
      },
    });
    const r = await appeler({ du: '2026-10-05', au: '2026-10-11', maille: 'semaine' });
    expect(r.series).toEqual([{ periode: '2026-10-05', conversations: 14, mesurees: 10, satisfaction: 3.6, urgence: 3.8 }]);
    expect(r.synthese.sentiment).toEqual({ positif: 5, neutre: 3, negatif: 2 });
    // Une maille sans mesure ne vaut pas 0 : elle vaut null.
    expect(r.a_savoir.join(' ')).toMatch(/encore gardées \(90 jours\)/);
    const vide = await appeler({ du: '2026-10-12', au: '2026-10-12' });
    expect(vide.series).toEqual([{ periode: '2026-10-12', conversations: 0, mesurees: 0, satisfaction: null, urgence: null }]);
  });
});

describe('aLaMaille', () => {
  it('🔴 une date qui revient dans une série s’additionne, au jour comme à la semaine', () => {
    const range = { from: '2026-10-05', to: '2026-10-06' };
    const serie = [{ date: '2026-10-05', count: 2 }, { date: '2026-10-05', count: 1 }, { date: '2026-10-06', count: 4 }];
    expect(aLaMaille(range, 'jour', { n: serie })).toEqual([{ periode: '2026-10-05', n: 3 }, { periode: '2026-10-06', n: 4 }]);
    expect(aLaMaille(range, 'semaine', { n: serie })).toEqual([{ periode: '2026-10-05', n: 7 }]);
  });
});

describe('get_ai_stats', () => {
  it('🔴 le coût des tours d’agent, les messages de l’IA, les demandes par maille, les actions par maille et par action', async () => {
    const appeler = appelerOutil('get_ai_stats', {
      getCoutIa: async () => ({ coutMicroEur: 2_345_000, tokensEntree: 1000, tokensSortie: 200, sessions: 4, tours: [], tronque: false }),
      stats: {
        getDashboard: async () => ({
          contacts: [], contactsActifs: [], templates: { utility: [], marketing: [] }, exchanged: [], service: [],
          serviceParOrigine: { ia: 7, scenario: 0, humain: 0, indeterminee: 0 }, serviceIaDetail: { agent: 5, mba: 2, mcp: 0 },
        }),
        demandesEquipeParJour: async () => [{ date: '2026-10-05', count: 2 }, { date: '2026-10-07', count: 1 }],
        // Deux actions le MÊME jour : elles s'additionnent dans la série, aucune n'écrase l'autre.
        actionsAgentParJour: async () => [
          { date: '2026-10-05', actionId: 'a1', nom: 'Résiliation', n: 2 },
          { date: '2026-10-05', actionId: 'a2', nom: 'Rappel', n: 1 },
          { date: '2026-10-07', actionId: 'a1', nom: 'Résiliation', n: 1 },
        ],
      },
    });
    const r = await appeler({ du: '2026-10-05', au: '2026-10-11', maille: 'semaine' });
    expect(r.credit_des_tours_d_agent).toEqual({ eur: 2.35, sessions: 4, jetons_entree: 1000, jetons_sortie: 200 });
    expect(r).not.toHaveProperty('credit_consomme');
    expect(r.a_savoir.join(' ')).toMatch(/traduction/);
    expect(r.messages_ia).toEqual({ agent: 5, mba: 2, mcp: 0, total: 7 });
    expect(r.demandes_pour_l_equipe).toEqual([{ periode: '2026-10-05', demandes: 3 }]);
    expect(r.actions.series).toEqual([{ periode: '2026-10-05', declenchees: 4 }]);
    expect(r.actions.par_action).toEqual([{ action_id: 'a1', nom: 'Résiliation', total: 3 }, { action_id: 'a2', nom: 'Rappel', total: 1 }]);
  });
});

describe('le catalogue', () => {
  it('🔴 les trois outils du Pro sont réservés à leur fonction de l’offre, en lecture, sans personne requise', () => {
    // Spec offres v2 : ce que l'analyse a compris suit la fonction `analyse` (l'Entreprise seule, à la livraison 5), pas
    // les statistiques, sinon un Pro sans analyse recevrait des chiffres vides.
    const attendue: Record<string, string> = { get_campaign_stats: 'statistiques', get_conversation_insights: 'analyse', get_ai_stats: 'statistiques' };
    for (const nom of Object.keys(attendue)) {
      const o = OUTILS_CHIFFRES.find((x) => x.nom === nom)!;
      expect(o.fonction, nom).toBe(attendue[nom]);
      expect(o.scope, nom).toBe('mcp:read');
      expect(o.exigePersonne, nom).toBeUndefined();
      expect(o.annotations.readOnlyHint, nom).toBe(true);
    }
  });

  it('🔴 une lecture, ouverte à toutes les offres et à toute clé de lecture, sans personne requise', () => {
    expect(outil.scope).toBe('mcp:read');
    expect(outil.fonction).toBeNull();
    expect(outil.exigePersonne).toBeUndefined();
    expect(outil.annotations.readOnlyHint).toBe(true);
  });
});
