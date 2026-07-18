import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // UN fichier à la fois. Chaque fichier d'intégration ouvre son propre `pg.Pool` (jusqu'à 10 connexions par
    // défaut) et le pooler Supabase en mode session plafonne à 15 clients : en parallèle, les derniers fichiers
    // se prenaient un EMAXCONNSESSION avant même d'avoir tourné (des échecs sans aucun rapport avec le code
    // testé). En série, chaque pool est fermé (afterAll -> pool.end) avant que le suivant s'ouvre.
    fileParallelism: false,
  },
});
