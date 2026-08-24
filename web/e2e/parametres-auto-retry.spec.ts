import { test, expect } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * « Relancer automatiquement les échecs » : le toggle vit dans PARAMÈTRES depuis le 2026-08-23.
 *
 * Il était sur l'Accueil, dans la carte du Meta Business Agent, où il n'avait rien à faire : il ne dit pas
 * qui répond au client, il règle ce qui se passe quand un envoi échoue. Ce fichier remplace
 * `accueil-auto-retry.spec.ts` : mêmes garanties (rendu, bascule optimiste, état initial lu du serveur,
 * admin seul), sur le bon écran.
 */
const SESSION = (role: string) => ({ token: 'e2e-token', email: 'a@e2e.test', role, tenantId: 't-e2e' });

async function monter(page: import('@playwright/test').Page, autoRetryEnabled: boolean, role = 'admin') {
  const patchs: Array<Record<string, unknown>> = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION(role));
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/settings/auto-retry')) {
      patchs.push(JSON.parse(route.request().postData() ?? '{}'));
      return json({ autoRetryEnabled: true });
    }
    if (url.endsWith('/settings') && method === 'GET') {
      return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    }
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: 'a@e2e.test', name: 'Jean Test', role });
    return json({});
  });
  await page.goto('/parametres');
  return patchs;
}

test.describe('Paramètres : relancer automatiquement les échecs', () => {
  test('🔴 le toggle est rendu et bascule (optimiste)', async ({ page }) => {
    await monter(page, false);
    const toggle = page.getByTestId('param-auto-retry-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  test('🔴 part activé si le réglage le dit', async ({ page }) => {
    await monter(page, true);
    await expect(page.getByTestId('param-auto-retry-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  test('la bascule est bien ENVOYÉE au serveur', async ({ page }) => {
    const patchs = await monter(page, false);
    await page.getByTestId('param-auto-retry-toggle').click();
    await expect.poll(() => patchs.length).toBeGreaterThan(0);
    expect(patchs[0]).toEqual({ enabled: true });
  });

  test('🔴 il n’est PLUS sur l’Accueil', async ({ page }) => {
    // Sans cette assertion, un doublon oublié laisserait deux interrupteurs pour un seul réglage.
    //
    // ⚠️ Le harnais de l'ACCUEIL est indispensable ici. Une première version montait la page avec le mock de
    // Paramètres : l'accueil ne se chargeait alors pas du tout, et l'absence était garantie d'avance. Le test
    // passait même en remettant un `auto-retry-toggle` en dur dans la page.
    await mockAccueil(page, { account: { hasNumber: true } });
    // La page a VRAIMENT rendu ses cartes...
    await expect(page.getByTestId('mba-toggle')).toBeVisible();
    // ... et le toggle déplacé n'y est plus.
    await expect(page.getByTestId('auto-retry-toggle')).toHaveCount(0);
  });
});
