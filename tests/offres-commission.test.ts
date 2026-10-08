import { describe, it, expect } from 'vitest';
import { commissionPour } from '../src/offres/commission';
import { OffresEnCache } from '../src/offres/cache';
import { DROITS, type Offre } from '../src/offres/offres';

/**
 * LA COMMISSION SUR LE CRÉDIT IA SUIT L'OFFRE (lot 6, livraison C, tâche 17) : 50 % en Base, 10 % en Pro et en
 * Entreprise, lue dans la grille (`src/offres/offres.ts`), seule source. Le tour d'agent, son essai, la traduction et le
 * catalogue des modèles affiché la lisent par cette fonction.
 */
const source = { offreDe: async (t: string) => ({ offre: t as Offre, droits: DROITS[t as Offre], retourEnBaseLe: null }) };

describe('la commission de l’espace', () => {
  it('🔴 50 % en Base, 10 % en Pro et en Entreprise : la grille, et elle seule', async () => {
    const c = commissionPour(source);
    expect(await c('base')).toBe(50);
    expect(await c('pro')).toBe(10);
    expect(await c('entreprise')).toBe(10);
    expect(await c('base')).toBe(DROITS.base.limites.commissionPct);
  });

  it('une offre illisible rend la commission de l’Entreprise (le repli du cache) : jamais une panne du tour', async () => {
    const cache = new OffresEnCache({ offreDe: async () => { throw new Error('base indisponible'); } }, Date.now, () => {});
    expect(await commissionPour(cache)('t1')).toBe(DROITS.entreprise.limites.commissionPct);
  });
});
