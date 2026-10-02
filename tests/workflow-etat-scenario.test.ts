import { describe, it, expect } from 'vitest';
import { etatDuScenario } from '../src/workflow/store.pg';
import type { WorkflowGraph } from '../src/workflow/graph';

/**
 * `etatDuScenario` dit si un scénario peut DÉMARRER, pour ceux qui le désignent sans personne devant (le bouton d'un
 * lien de chaîne, la bulle d'un widget). Le cas qui a motivé ce fichier : une ancienne ligne dont le graphe publié
 * n'a pas de `nodes`, que `listResume` prévoit déjà ; la lecture levait, et la désignation rendait une 500.
 */
describe('etatDuScenario', () => {
  const graphe = (g: unknown): { graph: WorkflowGraph } => ({ graph: g as WorkflowGraph });

  it('absent de l’espace : inconnu', () => {
    expect(etatDuScenario(null)).toBe('inconnu');
  });

  it('un graphe publié avec au moins un bloc : ok ; sans bloc : vide', () => {
    expect(etatDuScenario(graphe({ nodes: [{ id: 'a' }], edges: [] }))).toBe('ok');
    expect(etatDuScenario(graphe({ nodes: [], edges: [] }))).toBe('vide');
  });

  it('🔴 une ancienne ligne dont le graphe n’a PAS de nodes se lit vide, sans lever', () => {
    expect(() => etatDuScenario(graphe({}))).not.toThrow();
    expect(etatDuScenario(graphe({}))).toBe('vide');
  });
});
