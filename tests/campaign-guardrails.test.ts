import { describe, it, expect } from 'vitest';
import { optInAllows, frequencyAllows, qualityGate, buildComponents } from '../src/campaign/guardrails';
import type { GuardrailThresholds } from '../src/campaign/types';

const T: GuardrailThresholds = { frequencyWindowMs: 1000, maxFailureRate: 0.3, minSendsForFailureCheck: 5 };

describe('optInAllows', () => {
  it('marketing exige opted_in', () => {
    expect(optInAllows('marketing', { optInStatus: 'opted_in' })).toBe(true);
    expect(optInAllows('marketing', { optInStatus: 'unknown' })).toBe(false);
    expect(optInAllows('marketing', { optInStatus: 'opted_out' })).toBe(false);
  });
  it('utility passe toujours', () => {
    expect(optInAllows('utility', { optInStatus: 'unknown' })).toBe(true);
  });
});

describe('frequencyAllows', () => {
  it('jamais envoyé -> autorisé', () => {
    expect(frequencyAllows(null, 1000, 500)).toBe(true);
  });
  it('bloque dans la fenêtre, autorise au-delà', () => {
    expect(frequencyAllows(600, 1000, 500)).toBe(false); // 400 < 500
    expect(frequencyAllows(400, 1000, 500)).toBe(true); // 600 >= 500
  });
});

describe('qualityGate', () => {
  it('RED -> pause', () => {
    expect(qualityGate({ rating: 'RED', sent: 0, failed: 0 }, T).pause).toBe(true);
  });
  it('taux d échec au-delà du seuil (après minimum) -> pause', () => {
    // 6 envois, 3 échecs = 50% > 30%, total 6 >= min 5
    expect(qualityGate({ rating: 'GREEN', sent: 3, failed: 3 }, T).pause).toBe(true);
  });
  it('sous le minimum d envois -> pas de pause même si échecs', () => {
    expect(qualityGate({ rating: 'GREEN', sent: 0, failed: 2 }, T).pause).toBe(false);
  });
  it('GREEN sous le seuil -> pas de pause', () => {
    expect(qualityGate({ rating: 'GREEN', sent: 10, failed: 1 }, T).pause).toBe(false);
  });
});

describe('buildComponents', () => {
  it('params vides -> aucun composant', () => {
    expect(buildComponents([])).toEqual([]);
  });
  it('params -> composant body avec paramètres text', () => {
    expect(buildComponents(['Julie', 'Lyon'])).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Julie' }, { type: 'text', text: 'Lyon' }] },
    ]);
  });
});
