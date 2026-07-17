import { describe, it, expect } from 'vitest';
import { campaignJobExpireSeconds } from '../src/campaign/pacing';

/**
 * Lot 8 Phase 4 : dimensionnement du timeout d'un job campaign-run. Un timeout FIXE (ex. 7200 s) ne couvre
 * qu'une petite liste au débit minimal -> un run long expire et est rejoué en parallèle (débit réel doublé).
 * Le timeout doit suivre le TRAVAIL RÉEL (destinataires / débit).
 */
describe('campaignJobExpireSeconds', () => {
  it('plancher 15 min pour une petite campagne (ou 0 destinataire)', () => {
    expect(campaignJobExpireSeconds(0, null)).toBe(900);
    expect(campaignJobExpireSeconds(0, 80)).toBe(900);
    expect(campaignJobExpireSeconds(10, 80)).toBe(900); // 10/80 min ~ négligeable -> plancher
  });

  it('grosse liste à débit BAS -> timeout largement au-dessus de 15 min (couvre le run entier)', () => {
    // 1000 à 1/min : durée ~1000 min = 60000 s ; 1.5x + 600 = 90600 s (~25 h).
    expect(campaignJobExpireSeconds(1000, 1)).toBe(90_600);
    // 500 à 5/min : durée = 500/5*60 = 6000 s ; 1.5x + 600 = 9600 s (2h40, > la constante fixe 7200 s abandonnée).
    expect(campaignJobExpireSeconds(500, 5)).toBe(9600);
  });

  it('débit au plafond (80/min) : timeout raisonnable proportionnel', () => {
    // 8000 à 80/min : durée = 6000 s ; 1.5x + 600 = 9600 s.
    expect(campaignJobExpireSeconds(8000, 80)).toBe(9600);
  });

  it('sans débit (null) : plancher de débit prudent 30/min -> timeout généreux', () => {
    // 1000 sans throttle, estimé à 30/min : durée ~2000 s ; 1.5x + 600 ~ 3600 s (1 h), généreux vs run réel court.
    // Plage (pas d'égalité stricte : arithmétique flottante sur 1000/30).
    const v = campaignJobExpireSeconds(1000, null);
    expect(v).toBeGreaterThanOrEqual(3600);
    expect(v).toBeLessThan(3700);
  });

  it('monotone : plus de destinataires -> timeout >= (jamais plus petit)', () => {
    expect(campaignJobExpireSeconds(2000, 10)).toBeGreaterThanOrEqual(campaignJobExpireSeconds(1000, 10));
  });
});
