import { describe, it, expect } from 'vitest';
import { etatAbonnement, liberationPrevue, DELAI_COUPURE_IMPAYE_MS, DELAI_LIBERATION_MS, type LigneEtat } from '../src/stripe/etat-abonnement';

/**
 * L'ÉTAT DE L'ABONNEMENT DU NUMÉRO, CALCULÉ SUR DES DATES (lot 4, spec docs/superpowers/specs/2026-10-06-numero-impaye-design.md).
 * Aucun balayage n'écrit de statut : « suspendu » est vrai dès que la date passe. Un seul calcul, partagé par la garde
 * d'envoi, l'état de la connexion, les outils MCP, le bandeau et le balayage.
 */
const MAINTENANT = new Date('2026-10-20T12:00:00Z');
const il_y_a = (ms: number) => new Date(MAINTENANT.getTime() - ms);
const HEURE = 3_600_000;
const JOUR = 24 * HEURE;
const base: LigneEtat = { statut: 'actif', premierEchecLe: null, finPrevueLe: null, finiLe: null, libereLe: null };
const etat = (l: Partial<LigneEtat>, numeroAttribue = true, numeroApporte = false) =>
  etatAbonnement({ ...base, ...l }, { maintenant: MAINTENANT, numeroAttribue, numeroApporte });

describe('etatAbonnement', () => {
  it('les délais de la spec : 7 jours avant la coupure, 7 jours avant la libération', () => {
    expect(DELAI_COUPURE_IMPAYE_MS).toBe(7 * JOUR);
    expect(DELAI_LIBERATION_MS).toBe(7 * JOUR);
  });

  it('payé, sans fin prévue : actif', () => {
    expect(etat({})).toBe('actif');
  });

  it('payé, résiliation programmée : fin prévue (les envois restent ouverts)', () => {
    expect(etat({ finPrevueLe: new Date('2026-11-06T14:51:15Z') })).toBe('fin_prevue');
  });

  it('🔴 la borne de l’impayé : 6 jours et 23 heures, en retard ; 7 jours, suspendu', () => {
    expect(etat({ statut: 'en_retard', premierEchecLe: il_y_a(7 * JOUR - HEURE) })).toBe('en_retard');
    expect(etat({ statut: 'en_retard', premierEchecLe: il_y_a(7 * JOUR) })).toBe('suspendu');
  });

  it('un échec sans date (ligne d’avant le lot 4) reste en retard, jamais suspendu sur une date inventée', () => {
    expect(etat({ statut: 'en_retard' })).toBe('en_retard');
  });

  it('🔴 fini : suspendu tout de suite, tant que le numéro n’est pas libéré', () => {
    expect(etat({ statut: 'resilie', finiLe: il_y_a(HEURE) })).toBe('suspendu');
    expect(etat({ statut: 'resilie', finiLe: il_y_a(10 * JOUR) })).toBe('suspendu');
  });

  it('résilié sans date de fin (avant la reprise) : suspendu quand même, la fin compte', () => {
    expect(etat({ statut: 'resilie' })).toBe('suspendu');
  });

  it('libéré : libéré, quoi que disent les autres dates', () => {
    expect(etat({ statut: 'resilie', finiLe: il_y_a(8 * JOUR), libereLe: il_y_a(JOUR) })).toBe('libere');
  });

  it('fini sans numéro attribué (rendu par « Abandonner ») : rien à suspendre, libéré', () => {
    expect(etat({ statut: 'resilie', finiLe: il_y_a(HEURE) }, false)).toBe('libere');
  });

  it('un impayé sans numéro attribué reste dû : en retard puis suspendu', () => {
    expect(etat({ statut: 'en_retard', premierEchecLe: il_y_a(JOUR) }, false)).toBe('en_retard');
    expect(etat({ statut: 'en_retard', premierEchecLe: il_y_a(8 * JOUR) }, false)).toBe('suspendu');
  });

  it('🔴 un AUTRE numéro connecté (le sien) : rien de chez nous n’est coupé, jamais « suspendu » (jaune 1 de la relecture de A)', () => {
    // Fini : le numéro fourni n'envoie pas, rien à suspendre ; la libération le rendra à J+7.
    expect(etat({ statut: 'resilie', finiLe: il_y_a(HEURE) }, true, true)).toBe('libere');
    // Impayé depuis 8 jours : c'est dû, mais le numéro qui envoie n'est pas le nôtre et n'est pas coupé.
    expect(etat({ statut: 'en_retard', premierEchecLe: il_y_a(8 * JOUR) }, true, true)).toBe('en_retard');
    expect(etat({ statut: 'en_retard', premierEchecLe: il_y_a(8 * JOUR) }, false, true)).toBe('en_retard');
  });

  it('une fin prévue sur un abonnement fini ne ressuscite rien : suspendu', () => {
    expect(etat({ statut: 'resilie', finiLe: il_y_a(HEURE), finPrevueLe: il_y_a(HEURE) })).toBe('suspendu');
  });
});

describe('liberationPrevue', () => {
  it('7 jours après la fin ; aucune date sans fin', () => {
    expect(liberationPrevue({ finiLe: new Date('2026-10-06T15:14:51Z') })).toEqual(new Date('2026-10-13T15:14:51Z'));
    expect(liberationPrevue(base)).toBeNull();
  });
});
