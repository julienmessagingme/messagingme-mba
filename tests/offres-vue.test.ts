import { describe, it, expect } from 'vitest';
import { creerVueOffre } from '../src/offres/vue';
import { DROITS, FONCTIONS, PRIX_PRO_HT_CENTIMES, droitsDe, type Offre } from '../src/offres/offres';

/**
 * LA VUE DE L'OFFRE (lot 6, tâche 6) : la même pour la console et pour Claude. Les fonctions dans l'ordre de la grille,
 * les limites telles quelles, l'usage, et le lien vers l'offre.
 */
function vue(
  offre: Offre, mois: { max: number; reste: number } | null, proEnVente = true, suite: { finPrevueLe: Date | null; rendreNumero: boolean } | null = null,
  essai: { dejaEuUnPro: boolean; finLe: Date | null } = { dejaEuUnPro: false, finLe: null },
) {
  return creerVueOffre({
    offres: { offreDe: async () => ({ offre, droits: DROITS[offre], retourEnBaseLe: null }) },
    usage: async () => ({ contacts: 42, automations: 3, membres: 1 }),
    modelesDuMois: { etatDuMois: async () => mois },
    proEnVente,
    suiteDuNumero: async () => suite,
    essai: async () => essai,
    siegesEnVente: true,
  });
}

describe('la suite du numéro fourni dans la vue (lot 6, B2b)', () => {
  it('🔴 un Pro qui finit : la date et le choix de rendre, pour la console et pour Claude', async () => {
    const fin = new Date('2026-11-08T10:00:00Z');
    expect((await vue('pro', null, true, { finPrevueLe: fin, rendreNumero: false })('t1')).suiteDuNumero)
      .toEqual({ finPrevueLe: '2026-11-08T10:00:00.000Z', rendreNumero: false });
    expect((await vue('pro', null, true, { finPrevueLe: null, rendreNumero: true })('t1')).suiteDuNumero)
      .toEqual({ finPrevueLe: null, rendreNumero: true });
  });

  it('sans Pro vivant ou sans numéro fourni : rien', async () => {
    expect((await vue('base', null)('t1')).suiteDuNumero).toBeNull();
  });
});

describe('creerVueOffre', () => {
  it('🔴 une Base : aucune fonction gardée, ses limites, et les modèles CONSOMMÉS ce mois-ci', async () => {
    const v = await vue('base', { max: 1000, reste: 750 })('t1');
    // Le nom PUBLIC (décision du 2026-10-08) : « Free », la base et le code serveur gardant `base`.
    expect(v.offre).toBe('free');
    expect(v.fonctions).toEqual([]);
    expect(v.limites).toEqual(DROITS.base.limites);
    expect(v.usage).toEqual({ envoisModelesMois: 250, contacts: 42, automations: 3, membres: 1 });
    expect(v.upgradeUrl).toMatch(/\/offre$/);
  });

  it('un Pro : ses fonctions dans l’ordre de la grille, et les modèles du mois non comptés (sans limite)', async () => {
    const v = await vue('pro', null)('t1');
    expect(v.fonctions).toEqual(['inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'email', 'console']);
    expect(v.usage.envoisModelesMois).toBeNull();
  });

  it('🔴 la vue porte la GRILLE des trois offres, lue dans la seule définition : la console ne la recopie jamais', async () => {
    const v = await vue('base', null)('t1');
    expect(Object.keys(v.grille)).toEqual(['free', 'pro', 'entreprise']);
    for (const [publique, o] of [['free', 'base'], ['pro', 'pro'], ['entreprise', 'entreprise']] as const) {
      expect(v.grille[publique].limites).toEqual(DROITS[o].limites);
      expect(v.grille[publique].fonctions).toEqual(FONCTIONS.filter((f) => DROITS[o].fonctions.has(f)));
    }
    expect(v.grille.entreprise.fonctions).toEqual([...FONCTIONS]);
    v.grille.pro.limites.utilisateurs = 9999;
    expect(DROITS.pro.limites.utilisateurs).toBe(3);
  });

  it('🔴 la vue porte les prix HT du Pro, lus dans la grille : 49 € par mois, 490 € par an (lot 6, B1)', async () => {
    const v = await vue('base', null)('t1');
    expect(v.prixPro).toEqual({ moisCentimes: 4900, anCentimes: 49000 });
    expect(v.prixPro).toEqual({ moisCentimes: PRIX_PRO_HT_CENTIMES.mois, anCentimes: PRIX_PRO_HT_CENTIMES.an });
  });

  it('🟡 le Pro pas encore en vente (prix Stripe pas posés) : aucun prix, la console renvoie au Support sans faire cliquer', async () => {
    expect((await vue('base', null, false)('t1')).prixPro).toBeNull();
  });

  it('les limites rendues sont une copie : la modifier ne touche pas la grille', async () => {
    const v = await vue('base', null)('t1');
    v.limites.contacts = 9999;
    expect(DROITS.base.limites.contacts).toBe(100);
  });
});

/** L'ESSAI DE 14 JOURS DANS LA VUE (spec offres v2, livraison 6) : la console et Claude le proposent, puis en disent la fin. */
describe('l’essai du Pro dans la vue', () => {
  it('🔴 une Free qui n’a jamais eu de Pro, le Pro en vente : l’essai de 14 jours est possible', async () => {
    expect((await vue('base', null)('t1')).essai).toEqual({ jours: 14, possible: true, finLe: null });
  });

  it('🔴 pas d’essai pour un espace qui a déjà eu un Pro, pour un Pro, une Entreprise, ou tant que le Pro n’est pas en vente', async () => {
    expect((await vue('base', null, true, null, { dejaEuUnPro: true, finLe: null })('t1')).essai.possible).toBe(false);
    expect((await vue('pro', null)('t1')).essai.possible).toBe(false);
    expect((await vue('entreprise', null)('t1')).essai.possible).toBe(false);
    expect((await vue('base', null, false)('t1')).essai.possible).toBe(false);
  });

  it('un Pro en essai : la date de fin, pour « votre essai se termine le … »', async () => {
    const fin = new Date('2026-11-02T09:00:00Z');
    expect((await vue('pro', null, true, null, { dejaEuUnPro: true, finLe: fin })('t1')).essai)
      .toEqual({ jours: 14, possible: false, finLe: '2026-11-02T09:00:00.000Z' });
  });
});

describe('les sièges du Pro dans la vue (spec offres v2, livraison 7)', () => {
  const avecSieges = (offre: Offre, pro: { sieges: number; periodicite: 'mois' | 'an' } | null, siegesEnVente = true) => creerVueOffre({
    offres: { offreDe: async () => ({ offre, droits: droitsDe(offre, null, pro?.sieges ?? 0), retourEnBaseLe: null, pro }) },
    usage: async () => ({ contacts: 0, automations: 0, membres: 4 }),
    modelesDuMois: { etatDuMois: async () => null },
    proEnVente: true,
    suiteDuNumero: async () => null,
    essai: async () => ({ dejaEuUnPro: true, finLe: null }),
    siegesEnVente,
  });

  it('🔴 un Pro annuel avec deux sièges : 3 inclus, 2 achetés, la limite à 5, le prix de sa formule lisible', async () => {
    const v = await avecSieges('pro', { sieges: 2, periodicite: 'an' })('t1');
    expect(v.sieges).toEqual({ inclus: 3, achetes: 2, periodicite: 'an' });
    expect(v.limites.utilisateurs).toBe(5);
    expect(v.prixSiege).toEqual({ moisCentimes: 1500, anCentimes: 15000 });
  });

  it('une Free : aucun siège, mais le prix pour la carte du Pro ; sièges pas en vente : aucun prix', async () => {
    const free = await avecSieges('base', null)('t1');
    expect(free.sieges).toBeNull();
    expect(free.prixSiege).toEqual({ moisCentimes: 1500, anCentimes: 15000 });
    expect((await avecSieges('pro', { sieges: 0, periodicite: 'mois' }, false)('t1')).prixSiege).toBeNull();
  });
});
