import { describe, it, expect } from 'vitest';
import {
  creerEstimationCampagne, eurosDisponibles, eurosManquants, messageManqueCredit, type DepsEstimation, type GroupeAEstimer,
} from '../src/credit-whatsapp/estimation';
import type { CategorieMeta, GrilleMeta } from '../src/credit-whatsapp/grille';
import type { LigneCredit } from '../src/credit-whatsapp/lignes.pg';

/**
 * L'ESTIMATION D'UNE CAMPAGNE AU LANCEMENT (plan du Crédit WhatsApp, tâche 6) : les destinataires en attente d'un étage
 * WhatsApp, au prix de la grille et commission comprise, comparés au solde. Sur des faux ; la requête qui groupe les
 * destinataires tourne sur la vraie base en CI (`tests/integration/credit-whatsapp-estimation.integration.test.ts`).
 */
const GRILLE: GrilleMeta = {
  id: 'g', enVigueurLe: '2026-10-01',
  tarifs: [
    { marche: 'FR', categorie: 'marketing', palier: 0, prixMicroEur: 71_200 },
    { marche: 'FR', categorie: 'utility', palier: 0, prixMicroEur: 24_800 },
    { marche: 'DE', categorie: 'marketing', palier: 0, prixMicroEur: 113_100 },
    { marche: 'other', categorie: 'marketing', palier: 0, prixMicroEur: 55_800 },
    { marche: 'other', categorie: 'utility', palier: 0, prixMicroEur: 7_100 },
  ],
};
const LIGNE: LigneCredit = { id: 'l1', tenantId: 't1', phoneNumberId: 'pn1', wabaId: 'w1', origine: 'ops', depuis: '2026-10-30T00:00:00Z', arreteeLe: null };
const FR = '+33612345678';
const DE = '+4915123456789';

function monter(groupes: GroupeAEstimer[], o: {
  solde?: number; ligne?: LigneCredit | null; openBar?: boolean; grille?: GrilleMeta | null; numero?: string | null;
  categories?: Record<string, CategorieMeta | null>; scenario?: { name: string; language: string } | null;
} = {}) {
  const lectures: string[] = [];
  const d: DepsEstimation = {
    numeroDeLEspace: async () => (o.numero === undefined ? 'pn1' : o.numero),
    lignes: { ligneDuNumero: async () => (o.ligne === undefined ? LIGNE : o.ligne) },
    conditions: async () => ({ openBar: o.openBar ?? false, commissionPct: 10 }),
    grille: async () => (o.grille === undefined ? GRILLE : o.grille),
    categorieDuModele: async (_t, nom) => { lectures.push(nom); return o.categories?.[nom] ?? null; },
    modeleDuScenario: async () => (o.scenario === undefined ? null : o.scenario),
    groupes: async () => groupes,
    solde: async () => o.solde ?? 0,
  };
  return { estimer: creerEstimationCampagne(d), lectures };
}
const modele = (name: string) => ({ name, language: 'fr' });

describe('l’estimation d’une campagne', () => {
  it('🔴 chaque groupe au prix de son pays et de la catégorie de son modèle, commission comprise', async () => {
    const { estimer } = monter([
      { exemple: FR, modele: modele('relance'), workflowId: null, n: 100 },
      { exemple: DE, modele: modele('promo'), workflowId: null, n: 10 },
    ], { categories: { relance: 'utility', promo: 'marketing' }, solde: 1_000_000 });
    const montant = 100 * 27_280 + 10 * 124_410;
    expect(await estimer('t1', 'c1')).toEqual({ montantMicroEur: montant, soldeMicroEur: 1_000_000, manqueMicroEur: montant - 1_000_000 });
  });

  it('un pays illisible (un identifiant sans numéro) et une catégorie inconnue se chiffrent au plus cher', async () => {
    const { estimer } = monter([{ exemple: 'US.13491208655302741918', modele: modele('inconnu'), workflowId: null, n: 1 }]);
    // Au plus cher des modèles, tous marchés confondus : le marketing allemand.
    expect((await estimer('t1', 'c1'))?.montantMicroEur).toBe(124_410);
  });

  it('un étage à scénario se chiffre sur le modèle qui l’ouvre ; sans modèle d’ouverture, au plus cher du pays', async () => {
    const ouvert = monter([{ exemple: FR, modele: null, workflowId: 'w1', n: 2 }], { scenario: modele('bienvenue'), categories: { bienvenue: 'utility' } });
    expect((await ouvert.estimer('t1', 'c1'))?.montantMicroEur).toBe(2 * 27_280);
    expect(ouvert.lectures).toEqual(['bienvenue']);
    const sansModele = monter([{ exemple: FR, modele: null, workflowId: 'w1', n: 1 }], { scenario: null });
    expect((await sansModele.estimer('t1', 'c1'))?.montantMicroEur).toBe(78_320);
  });

  it('une catégorie se lit une fois par contenu d’étage, pas une fois par groupe', async () => {
    const { estimer, lectures } = monter([
      { exemple: FR, modele: modele('relance'), workflowId: null, n: 5 },
      { exemple: DE, modele: modele('relance'), workflowId: null, n: 5 },
      { exemple: '+33712345678', modele: modele('relance'), workflowId: null, n: 5 },
    ], { categories: { relance: 'utility' } });
    await estimer('t1', 'c1');
    expect(lectures).toEqual(['relance']);
  });

  it('le solde couvre l’estimation : rien ne manque ; rien à envoyer : rien ne manque, même sur un solde négatif', async () => {
    const couvert = monter([{ exemple: FR, modele: modele('relance'), workflowId: null, n: 1 }], { categories: { relance: 'utility' }, solde: 27_280 });
    expect((await couvert.estimer('t1', 'c1'))?.manqueMicroEur).toBe(0);
    const vide = monter([], { solde: -5_000_000 });
    expect(await vide.estimer('t1', 'c1')).toEqual({ montantMicroEur: 0, soldeMicroEur: -5_000_000, manqueMicroEur: 0 });
    const dette = monter([{ exemple: FR, modele: modele('relance'), workflowId: null, n: 1 }], { categories: { relance: 'utility' }, solde: -1_000 });
    expect((await dette.estimer('t1', 'c1'))?.manqueMicroEur).toBe(28_280);
  });

  it('🔴 hors de la ligne, sur la ligne d’un autre espace, ligne arrêtée, en open bar, sans grille ou sans numéro : aucune estimation', async () => {
    const g = [{ exemple: FR, modele: modele('relance'), workflowId: null, n: 1 }];
    for (const [cas, o] of [
      ['hors ligne', { ligne: null }],
      ['autre espace', { ligne: { ...LIGNE, tenantId: 't2' } }],
      ['arrêtée', { ligne: { ...LIGNE, arreteeLe: '2026-10-30T12:00:00Z' } }],
      ['open bar', { openBar: true }],
      ['sans grille', { grille: null }],
      ['sans numéro', { numero: null }],
    ] as const) {
      expect(await monter(g, o).estimer('t1', 'c1'), cas).toBeNull();
    }
  });
});

describe('les montants dits au client', () => {
  it('ce qui manque s’arrondit au centime supérieur, le solde au centime inférieur', () => {
    expect(eurosManquants(1_480_001)).toBe('1,49');
    expect(eurosManquants(1_480_000)).toBe('1,48');
    expect(eurosDisponibles(1_489_999)).toBe('1,48');
  });

  it('le refus dit le montant HT, où recharger, et que rien n’est parti', () => {
    expect(messageManqueCredit(12_345_678)).toBe(
      'Crédit WhatsApp insuffisant pour cette campagne : il vous manque 12,35 € HT. Un administrateur peut recharger le crédit depuis Paramètres > Offre, puis la relancer. Rien n’est parti.',
    );
  });
});
