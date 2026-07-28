import { describe, it, expect } from 'vitest';
import { autoLayoutHorizontal } from '../web/lib/workflow-layout';

// Fonction PURE (aucune dépendance React/Flow) : gate testable du bouton « Auto-arranger ».

describe('autoLayoutHorizontal', () => {
  it('chaîne A->B->C : x croissant par couche, chacun centré (y=0)', () => {
    const pos = autoLayoutHorizontal([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [{ source: 'A', target: 'B' }, { source: 'B', target: 'C' }]);
    expect(pos.get('A')).toEqual({ x: 0, y: 0 });
    expect(pos.get('B')).toEqual({ x: 260, y: 0 });
    expect(pos.get('C')).toEqual({ x: 520, y: 0 });
  });

  it('branche A->B, A->C : B et C même colonne (x), rangs centrés différents', () => {
    const pos = autoLayoutHorizontal([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [{ source: 'A', target: 'B' }, { source: 'A', target: 'C' }]);
    expect(pos.get('B')!.x).toBe(260);
    expect(pos.get('C')!.x).toBe(260);
    expect(pos.get('B')!.y).toBe(-60);
    expect(pos.get('C')!.y).toBe(60);
  });

  it('losange : D en couche 2 (plus long chemin), pas 1', () => {
    const pos = autoLayoutHorizontal(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      [{ source: 'A', target: 'B' }, { source: 'A', target: 'C' }, { source: 'B', target: 'D' }, { source: 'C', target: 'D' }],
    );
    expect(pos.get('D')!.x).toBe(520);
  });

  it('déterministe : deux appels identiques donnent le même résultat', () => {
    const nodes = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
    const edges = [{ source: 'A', target: 'B' }, { source: 'A', target: 'C' }];
    expect([...autoLayoutHorizontal(nodes, edges)]).toEqual([...autoLayoutHorizontal(nodes, edges)]);
  });

  it('cycle A<->B : ne boucle pas, positions finies', () => {
    const pos = autoLayoutHorizontal([{ id: 'A' }, { id: 'B' }], [{ source: 'A', target: 'B' }, { source: 'B', target: 'A' }]);
    expect(pos.size).toBe(2);
    expect(Number.isFinite(pos.get('A')!.x)).toBe(true);
    expect(Number.isFinite(pos.get('B')!.y)).toBe(true);
  });

  it('node déconnecté : position valide (jamais NaN)', () => {
    const pos = autoLayoutHorizontal([{ id: 'A' }, { id: 'B' }, { id: 'Z' }], [{ source: 'A', target: 'B' }]);
    expect(Number.isFinite(pos.get('Z')!.x)).toBe(true);
    expect(Number.isFinite(pos.get('Z')!.y)).toBe(true);
  });

  it('edge vers un node inexistant : ignorée', () => {
    const pos = autoLayoutHorizontal([{ id: 'A' }], [{ source: 'A', target: 'ghost' }]);
    expect(pos.get('A')).toEqual({ x: 0, y: 0 });
    expect(pos.size).toBe(1);
  });

  it('entrée vide -> map vide', () => {
    expect(autoLayoutHorizontal([], []).size).toBe(0);
  });

  it('opts colGap/rowGap personnalisés', () => {
    const pos = autoLayoutHorizontal([{ id: 'A' }, { id: 'B' }], [{ source: 'A', target: 'B' }], { colGap: 100, rowGap: 40 });
    expect(pos.get('B')!.x).toBe(100);
  });
});
