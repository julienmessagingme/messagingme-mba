import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // L'intégration (Supabase) est hors du gate unitaire : voir vitest.integration.config.ts.
    exclude: [...configDefaults.exclude, 'tests/integration/**'],
  },
});
