import { describe, expect, it } from 'vitest';
import { historiqueMbaIndisponible } from './api-mba';

describe('contrat des mutations MBA dans la console', () => {
  it('distingue une mutation appliquée dont seul l’historique est indisponible', () => {
    expect(historiqueMbaIndisponible({ deleted: 'f1', avertissements: ['historique_indisponible'] })).toBe(true);
    expect(historiqueMbaIndisponible({ deleted: 'f1' })).toBe(false);
    expect(historiqueMbaIndisponible(null)).toBe(false);
  });
});
