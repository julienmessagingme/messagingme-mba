import { describe, it, expect } from 'vitest';
import { preparerImpression, CLASSE_ZONE } from './impression';

/** Faux élément : la préparation n'a besoin que de poser et retirer une classe. */
function fausseZone() {
  const classes = new Set<string>();
  return {
    classes,
    classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c) },
  };
}

describe('preparerImpression', () => {
  it('marque la zone et le corps du document', () => {
    const zone = fausseZone();
    const corps = { dataset: {} as Record<string, string | undefined> };
    preparerImpression(zone, corps);
    expect(zone.classes.has(CLASSE_ZONE)).toBe(true);
    expect(corps.dataset.impression).toBe('on');
  });

  it('🔴 la restauration remet EXACTEMENT l’état d’avant', () => {
    // C'est le seul risque réel : une zone restée marquée s'imprimerait avec la suivante, et le tableau du
    // client sortirait avec la carte d'à côté collée dessus.
    const zone = fausseZone();
    const corps = { dataset: {} as Record<string, string | undefined> };
    const restaurer = preparerImpression(zone, corps);
    restaurer();
    expect(zone.classes.has(CLASSE_ZONE)).toBe(false);
    expect('impression' in corps.dataset).toBe(false);
  });

  it('restaurer deux fois ne fait rien de plus (afterprint n’est pas garanti unique)', () => {
    const zone = fausseZone();
    const corps = { dataset: {} as Record<string, string | undefined> };
    const restaurer = preparerImpression(zone, corps);
    restaurer();
    restaurer();
    expect(zone.classes.size).toBe(0);
    expect(corps.dataset).toEqual({});
  });

  it('ne touche pas aux autres classes ni aux autres marqueurs du corps', () => {
    const zone = fausseZone();
    zone.classes.add('carte');
    const corps = { dataset: { theme: 'clair' } as Record<string, string | undefined> };
    preparerImpression(zone, corps)();
    expect([...zone.classes]).toEqual(['carte']);
    expect(corps.dataset).toEqual({ theme: 'clair' });
  });
});
