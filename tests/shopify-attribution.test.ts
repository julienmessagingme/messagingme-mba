import { describe, it, expect } from 'vitest';
import { choisirSource, FENETRE_ATTRIBUTION_JOURS, type Touche } from '../src/shopify/attribution';

/**
 * LE CHOIX DE LA SOURCE D'UNE VENTE (spec docs/superpowers/specs/2026-10-28-revenus-attribues-design.md, règles 1 à 4 ;
 * plan du même jour, tâche 3). Fonction pure : le store fournit les touches, déjà triées ou non.
 */
const payeeLe = new Date('2026-10-20T12:00:00Z');
const jours = (n: number) => new Date(payeeLe.getTime() - n * 86_400_000);
const touche = (o: Partial<Touche> & Pick<Touche, 'source' | 'le'>): Touche => ({ campaignId: null, modele: null, lanceScenario: false, ...o });

describe('le choix de la source d’une vente', () => {
  it('la fenêtre fait 5 jours', () => {
    expect(FENETRE_ATTRIBUTION_JOURS).toBe(5);
  });

  it('🔴 le panier relancé gagne, même après une conversation avec l’agent', () => {
    expect(choisirSource({
      payeeLe, touches: [touche({ source: 'agent', le: jours(1) })], panierRelance: { relanceLe: jours(2) }, toucheUtm: null,
    })).toEqual({ source: 'relance_panier', campaignId: null, preuve: 'panier', relanceLe: jours(2) });
  });

  it('la touche UTM gagne, même hors fenêtre, et garde sa campagne', () => {
    expect(choisirSource({
      payeeLe, touches: [touche({ source: 'agent', le: jours(1) })], panierRelance: null,
      toucheUtm: touche({ source: 'campagne', le: jours(9), campaignId: 'k-noel', modele: 'noel' }),
    })).toEqual({ source: 'campagne', campaignId: 'k-noel', preuve: 'utm', relanceLe: null });
  });

  it('une touche UTM de relance garde la date de la relance', () => {
    expect(choisirSource({
      payeeLe, touches: [], panierRelance: null, toucheUtm: touche({ source: 'relance_panier', le: jours(3), modele: 'relance' }),
    })).toEqual({ source: 'relance_panier', campaignId: null, preuve: 'utm', relanceLe: jours(3) });
  });

  it('sinon la dernière touche de la fenêtre, sans preuve, quel que soit l’ordre reçu', () => {
    expect(choisirSource({
      payeeLe, panierRelance: null, toucheUtm: null,
      touches: [touche({ source: 'scenario', le: jours(4) }), touche({ source: 'campagne', le: jours(1), campaignId: 'k1' }), touche({ source: 'agent', le: jours(2) })],
    })).toEqual({ source: 'campagne', campaignId: 'k1', preuve: null, relanceLe: null });
  });

  it('une touche à 5 jours pile compte, à 5 jours et une seconde non, après le paiement non plus', () => {
    const pile = new Date(payeeLe.getTime() - 5 * 86_400_000);
    expect(choisirSource({ payeeLe, panierRelance: null, toucheUtm: null, touches: [touche({ source: 'agent_meta', le: pile })] }))
      .toMatchObject({ source: 'agent_meta' });
    expect(choisirSource({ payeeLe, panierRelance: null, toucheUtm: null, touches: [touche({ source: 'agent', le: new Date(pile.getTime() - 1000) })] }))
      .toBeNull();
    expect(choisirSource({ payeeLe, panierRelance: null, toucheUtm: null, touches: [touche({ source: 'agent', le: new Date(payeeLe.getTime() + 1000) })] }))
      .toBeNull();
  });

  it('un scénario lancé par une campagne revient à la campagne', () => {
    expect(choisirSource({
      payeeLe, panierRelance: null, toucheUtm: null,
      touches: [touche({ source: 'scenario', le: jours(1) }), touche({ source: 'campagne', le: jours(2), campaignId: 'k-scen', lanceScenario: true })],
    })).toEqual({ source: 'campagne', campaignId: 'k-scen', preuve: null, relanceLe: null });
  });

  it('un scénario qui suit une campagne SANS scénario reste au scénario', () => {
    expect(choisirSource({
      payeeLe, panierRelance: null, toucheUtm: null,
      touches: [touche({ source: 'scenario', le: jours(1) }), touche({ source: 'campagne', le: jours(2), campaignId: 'k' })],
    })).toMatchObject({ source: 'scenario', campaignId: null });
  });

  it('une relance gagnante par la règle du dernier envoi garde sa date', () => {
    expect(choisirSource({ payeeLe, panierRelance: null, toucheUtm: null, touches: [touche({ source: 'relance_panier', le: jours(1) })] }))
      .toEqual({ source: 'relance_panier', campaignId: null, preuve: null, relanceLe: jours(1) });
  });

  it('aucune touche : null', () => {
    expect(choisirSource({ payeeLe, panierRelance: null, toucheUtm: null, touches: [] })).toBeNull();
  });
});
