import { defineConfig, devices } from '@playwright/test';

/**
 * E2E du front mba. Les appels `/api/backend/*` sont INTERCEPTÉS par page.route dans chaque spec (aucun backend
 * ni base requis) : le webServer ne sert que le Next buildé. BACKEND_URL n'est jamais atteint (fallback build).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  // Plafonné à 4 : le serveur Next est PARTAGÉ par tous les workers, et au-delà certains specs voyaient leur
  // requête de liste arriver après le rendu (échecs intermittents sur des assertions pourtant justes, vérifié
  // en repassant la suite à 1 worker : 54/54). On borne plutôt que de tolérer un gate qui ment.
  workers: 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: { baseURL: 'http://localhost:3000', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // `next start` émet un warning avec `output: standalone`, mais sert correctement les pages client-rendues
    // (accueil est 'use client') : l'E2E passe. On teste ainsi le build de PROD, pas le dev.
    command: 'npm run build && npm run start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { NEXT_TELEMETRY_DISABLED: '1', BACKEND_URL: 'http://127.0.0.1:9', NODE_ENV: 'production' },
  },
});
