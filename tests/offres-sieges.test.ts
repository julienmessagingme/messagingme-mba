import { describe, it, expect } from 'vitest';
import { DROITS, PRIX_SIEGE_HT_CENTIMES, droitsDe } from '../src/offres/offres';
import { creerGelMembres, limiteDepassee, verifierPlaceMembre, type RangMembre } from '../src/offres/membres';
import { LimiteOffreError, corpsRefusLimite, phraseLimite } from '../src/offres/refus';

/**
 * LES SIÈGES PAYANTS DU PRO (spec offres v2, livraison 7). Le Pro comprend 3 utilisateurs ; chaque siège acheté en ajoute
 * un, 15 € HT par mois ou 150 € HT par an selon la formule du Pro. La limite est posée en UN endroit (`droitsDe`) : la
 * vérification de l'invitation et le gel lisent la même valeur, pour qu'un 4e membre payé ne soit jamais gelé.
 */
const rang = (over: Partial<RangMembre>): RangMembre => ({ estAdmin: false, adminsAvant: 0, autresAvant: 0, admins: 0, ...over });

/** Une base simulée qui ne répond qu'au compte des membres de `verifierPlaceMembre`. */
const compte = (membres: number, admins: number) => ({
  query: async () => ({ rows: [{ membres, admins }] }),
}) as never;

describe('droitsDe : 3 utilisateurs, plus les sièges', () => {
  it('🔴 un Pro avec deux sièges a 5 utilisateurs ; ses administrateurs restent 2', () => {
    const d = droitsDe('pro', null, 2);
    expect(d.limites.utilisateurs).toBe(5);
    expect(d.limites.admins).toBe(DROITS.pro.limites.admins);
  });

  it('sans siège, le Pro de la grille ; la Free et l’Entreprise ignorent des sièges', () => {
    expect(droitsDe('pro', null).limites.utilisateurs).toBe(3);
    expect(droitsDe('base', null, 4).limites.utilisateurs).toBe(DROITS.base.limites.utilisateurs);
    expect(droitsDe('entreprise', { utilisateurs: 10, conservationJours: null }, 4).limites.utilisateurs).toBe(10);
  });

  it('les prix du siège : 15 € HT par mois, 150 € HT par an (spec)', () => {
    expect(PRIX_SIEGE_HT_CENTIMES).toEqual({ mois: 1500, an: 15000 });
  });
});

describe('🔴 l’invitation au-delà des sièges : refusée AVEC le prix', () => {
  it('un Pro mensuel à 3 sur 3 : 402 qui dit le prix et le siège à acheter', async () => {
    const limites = { utilisateurs: 3, admins: 2, offre: 'pro' as const, siege: { achetes: 0, periodicite: 'mois' as const } };
    const err = await verifierPlaceMembre(compte(3, 1), 't1', limites, 'agent', null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LimiteOffreError);
    const corps = corpsRefusLimite(err as LimiteOffreError);
    expect(corps).toMatchObject({
      code: 'plan_limit_reached', limite: 'utilisateurs', max: 3,
      siege: { cible: 1, periodicite: 'mois', prixHtCentimes: 1500 },
    });
    expect(corps.error).toMatch(/Ajoutez un utilisateur/);
    expect(corps.error).toMatch(/15 € HT par mois/);
    expect(corps.error).not.toMatch(/Passez en Pro/);
  });

  it('un Pro annuel avec un siège, à 4 sur 4 : le siège annuel, 150 € HT par an, le deuxième', async () => {
    const limites = { utilisateurs: 4, admins: 2, offre: 'pro' as const, siege: { achetes: 1, periodicite: 'an' as const } };
    const err = await verifierPlaceMembre(compte(4, 1), 't1', limites, 'agent', null).catch((e: unknown) => e);
    const corps = corpsRefusLimite(err as LimiteOffreError);
    expect(corps).toMatchObject({ max: 4, siege: { cible: 2, periodicite: 'an', prixHtCentimes: 15000 } });
    expect(corps.error).toMatch(/150 € HT par an/);
    // 4 n'est pas une valeur de la grille : sans l'offre, la phrase aurait dit « Contactez-nous ».
    expect(corps.error).not.toMatch(/Contactez-nous/);
  });

  it('les sièges pas en vente : le Pro lit « passez en Entreprise », sans prix ni siège', async () => {
    const limites = { utilisateurs: 3, admins: 2, offre: 'pro' as const, siege: null };
    const err = await verifierPlaceMembre(compte(3, 1), 't1', limites, 'agent', null).catch((e: unknown) => e);
    const corps = corpsRefusLimite(err as LimiteOffreError);
    expect(corps).not.toHaveProperty('siege');
    expect(corps.error).toMatch(/Passez en Entreprise/);
  });

  it('🔴 un administrateur de trop, utilisateurs pleins aussi : refusé sur les ADMINISTRATEURS, sans siège (payer ne le ferait pas passer)', async () => {
    const limites = { utilisateurs: 3, admins: 2, offre: 'pro' as const, siege: { achetes: 0, periodicite: 'mois' as const } };
    const err = await verifierPlaceMembre(compte(3, 2), 't1', limites, 'admin', null).catch((e: unknown) => e);
    const corps = corpsRefusLimite(err as LimiteOffreError);
    expect(corps.limite).toBe('admins');
    expect(corps).not.toHaveProperty('siege');
  });

  it('🔴 des membres DÉJÀ au-delà (un Pro repris avec des membres gelés) : un siège ne suffirait pas, aucun n’est proposé', async () => {
    const limites = { utilisateurs: 3, admins: 2, offre: 'pro' as const, siege: { achetes: 0, periodicite: 'mois' as const } };
    const err = await verifierPlaceMembre(compte(5, 1), 't1', limites, 'agent', null).catch((e: unknown) => e);
    expect(corpsRefusLimite(err as LimiteOffreError)).not.toHaveProperty('siege');
  });

  it('🔴 la réactivation d’un compte (pas une invitation) : aucun siège proposé, la phrase reste lisible avec son bandeau', async () => {
    const limites = { utilisateurs: 3, admins: 2, offre: 'pro' as const, siege: { achetes: 0, periodicite: 'mois' as const } };
    const err = await verifierPlaceMembre(compte(3, 1), 't1', limites, 'agent', 'u-revoque').catch((e: unknown) => e);
    expect(corpsRefusLimite(err as LimiteOffreError)).not.toHaveProperty('siege');
  });

  it('la phrase dit OÙ ajouter un utilisateur : en invitant le membre, jamais « depuis la page Offre »', () => {
    const p = phraseLimite('utilisateurs', 3, { offre: 'pro', siege: { cible: 1, periodicite: 'mois', prixHtCentimes: 1500 } });
    expect(p).toMatch(/en invitant le membre/);
    expect(p).not.toMatch(/depuis la page Offre/);
  });

  it('la limite d’administrateurs ne s’achète pas : pas de siège dans son refus', async () => {
    const limites = { utilisateurs: 5, admins: 2, offre: 'pro' as const, siege: { achetes: 2, periodicite: 'mois' as const } };
    const err = await verifierPlaceMembre(compte(3, 2), 't1', limites, 'admin', null).catch((e: unknown) => e);
    const corps = corpsRefusLimite(err as LimiteOffreError);
    expect(corps.limite).toBe('admins');
    expect(corps).not.toHaveProperty('siege');
  });

  it('une Free reste renvoyée au Pro, sans siège', () => {
    expect(phraseLimite('utilisateurs', 1)).toMatch(/Passez en Pro/);
    expect(corpsRefusLimite(new LimiteOffreError('t1', 'utilisateurs', 1))).not.toHaveProperty('siege');
  });
});

describe('🔴 le gel suit les sièges payés', () => {
  it('un Pro avec un siège : le 4e membre (2 administrateurs, 2 membres) n’est PAS gelé ; le 5e l’est', () => {
    const l = { utilisateurs: droitsDe('pro', null, 1).limites.utilisateurs, admins: 2 };
    expect(limiteDepassee(rang({ autresAvant: 1, admins: 2 }), l)).toBeNull();
    expect(limiteDepassee(rang({ autresAvant: 2, admins: 2 }), l)).toBe('utilisateurs');
  });

  it('le gel d’un Pro dit l’offre : la phrase du membre suspendu n’envoie pas « au Pro »', async () => {
    const gel = creerGelMembres({
      offres: { offreDe: async () => ({ offre: 'pro', droits: droitsDe('pro', null, 0), retourEnBaseLe: null }) },
      rang: async () => rang({ autresAvant: 1, admins: 2 }),
    });
    const h = await gel.horsOffre('t1', 'u4');
    expect(h).toEqual({ limite: 'utilisateurs', max: 3, offre: 'pro' });
  });
});
