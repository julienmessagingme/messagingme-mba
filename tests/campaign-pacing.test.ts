import { describe, it, expect } from 'vitest';
import { campaignJobExpireSeconds, resolveRatePerMinute } from '../src/campaign/pacing';

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

describe('resolveRatePerMinute (débit effectif partagé run-job / pacing)', () => {
  it('rate posé sur la campagne -> prime sur le défaut serveur', () => {
    expect(resolveRatePerMinute(60, 30)).toBe(60);
    expect(resolveRatePerMinute(15, 30)).toBe(15);
  });

  it('rate null -> défaut serveur', () => {
    expect(resolveRatePerMinute(null, 30)).toBe(30);
  });

  it('rate null + défaut serveur 0 (opt-out) -> 0 (aucun frein)', () => {
    expect(resolveRatePerMinute(null, 0)).toBe(0);
  });

  it('rate <= 0 traité comme non posé -> défaut serveur', () => {
    expect(resolveRatePerMinute(0, 30)).toBe(30);
    expect(resolveRatePerMinute(-5, 30)).toBe(30);
  });
});

describe('alignement pacing / run-job (pas de rejeu parallèle)', () => {
  // Le piège : pacing et run-job doivent voir le MÊME débit. Si un défaut serveur < 30 est appliqué au run
  // (run-job throttle), pacing doit l'estimer avec CE débit, pas avec son plancher de 30 (qui sous-estimerait la
  // durée -> expireInSeconds trop court -> pg-boss rejoue en parallèle). On passe donc le rate RÉSOLU à pacing.
  it('défaut serveur 15/min : la durée est estimée à 15/min, pas au plancher 30', () => {
    const resolu = resolveRatePerMinute(null, 15); // = 15
    const expire15 = campaignJobExpireSeconds(600, resolu);
    const expire30 = campaignJobExpireSeconds(600, 30);
    // 600 à 15/min = 2400 s de run ; à 30/min = 1200 s. L'estimation à 15 doit être STRICTEMENT plus grande
    // que celle à 30, sinon le run réel (15/min) dépasserait un timeout dimensionné pour 30/min.
    expect(expire15).toBeGreaterThan(expire30);
    // Et elle couvre bien la durée réelle du run à 15/min (2400 s), avec marge.
    expect(expire15).toBeGreaterThanOrEqual(2400);
  });

  it('défaut serveur >= 30 : pacing et run-job convergent (le plancher 30 ne mord jamais sur un rate positif)', () => {
    // resolu = 30 ; effectiveRate = 30 ; identique au cas opt-out estimé à 30. Pas de sous-dimensionnement.
    expect(campaignJobExpireSeconds(1000, resolveRatePerMinute(null, 30))).toBe(campaignJobExpireSeconds(1000, 30));
  });
});
