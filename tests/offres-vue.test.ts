import { describe, it, expect } from 'vitest';
import { creerVueOffre } from '../src/offres/vue';
import { DROITS, FONCTIONS, PRIX_PRO_HT_CENTIMES, type Offre } from '../src/offres/offres';

/**
 * LA VUE DE L'OFFRE (lot 6, tâche 6) : la même pour la console et pour Claude. Les fonctions dans l'ordre de la grille,
 * les limites telles quelles, l'usage, et le lien vers l'offre.
 */
function vue(offre: Offre, mois: { max: number; reste: number } | null) {
  return creerVueOffre({
    offres: { offreDe: async () => ({ offre, droits: DROITS[offre], retourEnBaseLe: null }) },
    usage: async () => ({ contacts: 42, automations: 3, membres: 1 }),
    modelesDuMois: { etatDuMois: async () => mois },
  });
}

describe('creerVueOffre', () => {
  it('🔴 une Base : aucune fonction gardée, ses limites, et les modèles CONSOMMÉS ce mois-ci', async () => {
    const v = await vue('base', { max: 1000, reste: 750 })('t1');
    expect(v.offre).toBe('base');
    expect(v.fonctions).toEqual([]);
    expect(v.limites).toEqual(DROITS.base.limites);
    expect(v.usage).toEqual({ envoisModelesMois: 250, contacts: 42, automations: 3, membres: 1 });
    expect(v.upgradeUrl).toMatch(/\/offre$/);
  });

  it('un Pro : ses fonctions dans l’ordre de la grille, et les modèles du mois non comptés (sans limite)', async () => {
    const v = await vue('pro', null)('t1');
    expect(v.fonctions).toEqual(['inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'analyse', 'publicites', 'email', 'chaines']);
    expect(v.usage.envoisModelesMois).toBeNull();
  });

  it('🔴 la vue porte la GRILLE des trois offres, lue dans la seule définition : la console ne la recopie jamais', async () => {
    const v = await vue('base', null)('t1');
    expect(Object.keys(v.grille)).toEqual(['base', 'pro', 'entreprise']);
    for (const o of ['base', 'pro', 'entreprise'] as const) {
      expect(v.grille[o].limites).toEqual(DROITS[o].limites);
      expect(v.grille[o].fonctions).toEqual(FONCTIONS.filter((f) => DROITS[o].fonctions.has(f)));
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

  it('les limites rendues sont une copie : la modifier ne touche pas la grille', async () => {
    const v = await vue('base', null)('t1');
    v.limites.contacts = 9999;
    expect(DROITS.base.limites.contacts).toBe(100);
  });
});
