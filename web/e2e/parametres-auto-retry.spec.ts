import { test, expect } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * « Relancer automatiquement les échecs » N'EST PLUS UN RÉGLAGE D'ESPACE (lot 3 de la liste de Julien du
 * 2026-09-23, migration 0165).
 *
 * La relance obéit à la case « Réessayer les envois qui échouent » de chaque campagne, que le balayage ne lisait
 * pas : elle était offerte et inerte, pendant que l'interrupteur des Paramètres décidait seul. Les campagnes
 * d'avant gardent la règle de l'espace, qui ne se change plus. Ce fichier remplaçait déjà
 * `accueil-auto-retry.spec.ts` ; il garde ce qui reste vrai : l'interrupteur n'est ni dans les Paramètres, ni
 * sur l'Accueil.
 */
const SESSION = { token: 'e2e-token', email: 'a@e2e.test', role: 'admin', tenantId: 't-e2e' };

async function monter(page: import('@playwright/test').Page) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.endsWith('/settings') && method === 'GET') {
      return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: true, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    }
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: 'a@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/parametres');
}

test.describe('Relancer automatiquement les échecs : plus un réglage d’espace', () => {
  test('🔴 il n’est PLUS dans les Paramètres, même quand l’espace l’avait activé', async ({ page }) => {
    await monter(page);
    // La page a VRAIMENT rendu ses sections d'administrateur...
    await expect(page.getByTestId('param-save-hours')).toBeVisible();
    // ... et l'interrupteur n'y est plus.
    await expect(page.getByTestId('param-auto-retry-card')).toHaveCount(0);
    await expect(page.getByTestId('param-auto-retry-toggle')).toHaveCount(0);
  });

  test('🔴 il n’est pas non plus sur l’Accueil', async ({ page }) => {
    // ⚠️ Le harnais de l'ACCUEIL est indispensable ici. Une première version montait la page avec le mock de
    // Paramètres : l'accueil ne se chargeait alors pas du tout, et l'absence était garantie d'avance. Le test
    // passait même en remettant un `auto-retry-toggle` en dur dans la page.
    await mockAccueil(page, { account: { hasNumber: true } });
    // La page a VRAIMENT rendu ses cartes...
    await expect(page.getByTestId('mba-toggle')).toBeVisible();
    // ... et aucun interrupteur de relance n'y est.
    await expect(page.getByTestId('auto-retry-toggle')).toHaveCount(0);
  });
});
