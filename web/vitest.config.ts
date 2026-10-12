import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Tests UNITAIRES du front (fonctions pures : format.ts, mapping). Scopé à `lib/**` : les specs Playwright
 * (`e2e/**.spec.ts`) sont exclues d'office et tournent via `npm run test:e2e`, jamais via vitest.
 */
export default defineConfig({
  // La doc en Markdown (lot 17, `lib/doc-md.test.ts`) rend les pages de la doc : l'alias `@/` et le JSX des `.tsx`.
  resolve: { alias: [{ find: /^@\//, replacement: fileURLToPath(new URL('./', import.meta.url)).replace(/\\/g, '/') }] },
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['lib/**/*.test.ts'],
    environment: 'node',
  },
});
