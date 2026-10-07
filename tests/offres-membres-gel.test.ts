import { describe, it, expect } from 'vitest';
import { limiteDepassee, creerGelMembres, type RangMembre } from '../src/offres/membres';
import { DROITS, type Offre } from '../src/offres/offres';

/**
 * 🔴 LES MEMBRES EN TROP AU RETOUR EN BASE (lot 6, livraison B2a, spec § 7) : au-delà des limites de l'offre, un membre
 * perd l'accès, et le plus ancien administrateur garde toujours le sien. L'ordre : les administrateurs d'abord (dans la
 * limite d'administrateurs), du plus ancien au plus récent, puis les autres membres, du plus ancien au plus récent,
 * jusqu'à la limite d'utilisateurs. Rien n'est effacé : au réabonnement, chacun retrouve l'accès.
 */
const rang = (over: Partial<RangMembre>): RangMembre => ({ estAdmin: false, adminsAvant: 0, autresAvant: 0, admins: 0, ...over });
const L = (o: Offre) => ({ utilisateurs: DROITS[o].limites.utilisateurs, admins: DROITS[o].limites.admins });

describe('limiteDepassee', () => {
  it('🔴 en Base (1 utilisateur, 1 administrateur) : seul le plus ancien administrateur garde l’accès', () => {
    expect(limiteDepassee(rang({ estAdmin: true, adminsAvant: 0, admins: 2 }), L('base'))).toBeNull();
    expect(limiteDepassee(rang({ estAdmin: true, adminsAvant: 1, admins: 2 }), L('base'))).toBe('admins');
    expect(limiteDepassee(rang({ estAdmin: false, autresAvant: 0, admins: 1 }), L('base'))).toBe('utilisateurs');
  });

  it('un espace sans administrateur actif garde son plus ancien membre', () => {
    expect(limiteDepassee(rang({ estAdmin: false, autresAvant: 0, admins: 0 }), L('base'))).toBeNull();
    expect(limiteDepassee(rang({ estAdmin: false, autresAvant: 1, admins: 0 }), L('base'))).toBe('utilisateurs');
  });

  it('en Pro (3 utilisateurs, 2 administrateurs) : deux administrateurs, puis les membres jusqu’à trois', () => {
    expect(limiteDepassee(rang({ estAdmin: true, adminsAvant: 1, admins: 3 }), L('pro'))).toBeNull();
    expect(limiteDepassee(rang({ estAdmin: true, adminsAvant: 2, admins: 3 }), L('pro'))).toBe('admins');
    // Le 3e administrateur, refusé, ne prend pas la place d'un membre : 2 administrateurs gardés + 1 membre.
    expect(limiteDepassee(rang({ autresAvant: 0, admins: 3 }), L('pro'))).toBeNull();
    expect(limiteDepassee(rang({ autresAvant: 1, admins: 3 }), L('pro'))).toBe('utilisateurs');
  });

  it('en Entreprise (sans limite) : personne n’est hors de l’offre', () => {
    expect(limiteDepassee(rang({ estAdmin: true, adminsAvant: 40, admins: 50 }), L('entreprise'))).toBeNull();
  });
});

describe('creerGelMembres', () => {
  it('🔴 rend la limite et son maximum ; sans limite, le rang n’est même pas lu', async () => {
    const lus: string[] = [];
    const gel = (offre: Offre) => creerGelMembres({
      offres: { offreDe: async () => ({ offre, droits: DROITS[offre], retourEnBaseLe: null }) },
      rang: async (_t, u) => { lus.push(u); return rang({ estAdmin: false, autresAvant: 0, admins: 1 }); },
    });
    expect(await gel('base').horsOffre('t1', 'u2')).toEqual({ limite: 'utilisateurs', max: 1 });
    expect(await gel('entreprise').horsOffre('t1', 'u3')).toBeNull();
    expect(lus).toEqual(['u2']);
  });

  it('un membre introuvable (supprimé entre-temps) n’est pas gelé ici : la garde le refuse déjà en 401', async () => {
    const gel = creerGelMembres({ offres: { offreDe: async () => ({ offre: 'base', droits: DROITS.base, retourEnBaseLe: null }) }, rang: async () => null });
    expect(await gel.horsOffre('t1', 'u9')).toBeNull();
  });
});
