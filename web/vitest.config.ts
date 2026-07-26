import { defineConfig } from 'vitest/config';

/**
 * Tests UNITAIRES du front (fonctions pures : format.ts, mapping). Scopé à `lib/**` : les specs Playwright
 * (`e2e/**.spec.ts`) sont exclues d'office et tournent via `npm run test:e2e`, jamais via vitest.
 */
export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts'],
    environment: 'node',
  },
});
