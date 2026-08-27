import { describe, it, expect } from 'vitest';
import { summarize } from '../src/workflow/node-list';

/**
 * `summarize` alimente la puce d'un bloc dans « Contenu > Blocs ». Le switch a un `default: ''`, donc tsc
 * n'attrape pas un type oublié : un bloc sans cas s'afficherait avec un résumé VIDE, indistinguable des
 * autres. C'est déjà arrivé deux fois (wait, puis rcs_message). Ce test verrouille le cas `agent`.
 */
describe('summarize (Contenu > Blocs)', () => {
  it('un bloc agent rend son label, pas un résumé vide', () => {
    expect(summarize('agent', { label: 'SAV commande' })).toBe('SAV commande');
  });

  it('un bloc agent sans label rend une chaîne vide, jamais un throw', () => {
    expect(summarize('agent', {})).toBe('');
  });
});
