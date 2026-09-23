import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 🔴 UNE SEULE LISTE RENDUE, QUELLE QUE SOIT L'ORIENTATION.
 *
 * Le passage des onglets en colonne invite à rendre deux blocs (`hidden lg:flex` et `lg:hidden`). Ce serait
 * la pire façon de le faire : les deux vivent dans le DOM, donc CHAQUE `data-testid="mba-tab-<cle>"` existe
 * en double. `web/e2e/mba-parametres-gate.spec.ts:14` exige `toHaveCount(0)` sur un écran bloqué et en
 * lirait 2 ; les onze `.click()` des cinq suites tomberaient en violation de mode strict Playwright.
 *
 * Ce test compte les occurrences du gabarit de testid dans la source. Il doit y en avoir EXACTEMENT UNE.
 */
const SRC = readFileSync(join(resolve(__dirname, '..'), 'web', 'components', 'MbaTabs.tsx'), 'utf8');

describe('MbaTabs', () => {
  it('🔴 ne rend le gabarit de data-testid QU UNE SEULE FOIS', () => {
    const occurrences = SRC.split('data-testid={`mba-tab-').length - 1;
    expect(occurrences, 'deux listes rendues feraient exister chaque testid en double, et cinq suites e2e '
      + 'tomberaient en violation de mode strict').toBe(1);
  });

  it('accepte une orientation, et son DEFAUT est horizontal', () => {
    // Le défaut compte autant que la prop : sans lui, les deux appelants existants changeraient de rendu
    // le jour du refactor, alors que ce lot veut que rien ne bouge tant qu'on ne le demande pas.
    expect(SRC).toContain('orientation');
    expect(SRC).toMatch(/orientation\s*=\s*'horizontale'/);
  });

  it('garde le gabarit de testid mot pour mot', () => {
    // Cinq suites e2e s'appuient dessus. Le renommer est la seule façon de rendre ce refactor cher.
    expect(SRC).toContain('data-testid={`mba-tab-${tab.key}`}');
  });
});
