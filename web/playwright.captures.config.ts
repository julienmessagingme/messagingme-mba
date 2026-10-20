import { defineConfig, devices } from '@playwright/test';

/**
 * LES CAPTURES DU CENTRE D'AIDE (plan docs/superpowers/plans/2026-10-20-centre-d-aide.md, tâche 8), lancées À LA MAIN
 * par `npm run aide:captures` à la racine, jamais par la CI : leurs fichiers s'appellent `*.capture.ts`, que la
 * configuration des e2e (`*.spec.ts`) ne ramasse pas.
 *
 * La console est la VRAIE (le build de production, servi comme pour les e2e), les données sont INVENTÉES : chaque
 * appel `/api/backend/*` est simulé (`e2e/captures/donnees-demo.ts`). Aucune session, aucun mot de passe, aucun envoi,
 * aucun vrai numéro à l'écran. Chaque scénario écrit ses PNG dans `e2e/captures/sortie/` ; le script de la racine les
 * passe en `.webp` dans `site/img/aide/`.
 */
export default defineConfig({
  testDir: './e2e/captures',
  testMatch: '**/*.capture.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } }],
  webServer: {
    command: 'npm run build && npm run start',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 600_000,
    env: { NEXT_TELEMETRY_DISABLED: '1', BACKEND_URL: 'http://127.0.0.1:9', NODE_ENV: 'production' },
  },
});
