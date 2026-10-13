import { describe, it, expect } from 'vitest';
import { OUTILS_CHIFFRES, aLaMaille, cleDeMaille, lirePeriode, type DepsChiffresMcp } from '../src/mcp/outils-chiffres';
import { RefusOutil } from '../src/mcp/saisie';
import { addDays, todayParis } from '../src/stats/range';
import { DROITS } from '../src/offres/offres';
import { adresseOffre } from '../src/offres/refus';
import type { DepsMcp } from '../src/mcp/outils';
import type { StatutsModelesJour } from '../src/stats/store.pg';

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
      stats: {
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

describe('le catalogue', () => {
  it('🔴 une lecture, ouverte à toutes les offres et à toute clé de lecture, sans personne requise', () => {
    expect(outil.scope).toBe('mcp:read');
    expect(outil.fonction).toBeNull();
    expect(outil.exigePersonne).toBeUndefined();
    expect(outil.annotations.readOnlyHint).toBe(true);
  });
});
