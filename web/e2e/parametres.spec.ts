import { test, expect } from '@playwright/test';

/**
 * E2E page Paramètres : le fuseau se règle (PATCH .../settings/timezone) et les heures d'ouverture s'enregistrent
 * (PATCH .../settings/business-hours, 7 jours). Backend intercepté, aucune base requise (pattern des E2E accueil).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const BUSINESS_HOURS = {
  '0': { closed: true, open: '', close: '' }, '1': { closed: false, open: '09:00', close: '18:00' },
  '2': { closed: false, open: '09:00', close: '18:00' }, '3': { closed: false, open: '09:00', close: '18:00' },
  '4': { closed: false, open: '09:00', close: '18:00' }, '5': { closed: false, open: '09:00', close: '18:00' },
  '6': { closed: true, open: '', close: '' },
};
const SETTINGS = { controlHandbackSeconds: null, mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, timezone: 'Europe/Paris', businessHours: BUSINESS_HOURS };

test.describe('Paramètres : fuseau + heures d’ouverture', () => {
  test('règle le fuseau (PATCH timezone) et enregistre les horaires (PATCH business-hours, 7 jours)', async ({ page }) => {
    const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (req.method() === 'PATCH' && url.includes('/settings/timezone')) {
        const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
        patches.push({ url, body });
        return json({ timezone: body.timezone });
      }
      if (req.method() === 'PATCH' && url.includes('/settings/business-hours')) {
        const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
        patches.push({ url, body });
        return json({ businessHours: body.businessHours });
      }
      if (url.includes('/settings')) return json(SETTINGS);
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await page.goto('/parametres');

    // Fuseau : présélectionné, puis changé -> PATCH .../settings/timezone { timezone }.
    const tz = page.getByTestId('param-timezone');
    await expect(tz).toBeVisible();
    await expect(tz).toHaveValue('Europe/Paris');
    await tz.selectOption('America/New_York');
    await expect.poll(() => patches.find((p) => p.url.includes('/settings/timezone'))?.body).toMatchObject({ timezone: 'America/New_York' });

    // Horaires : le bouton Enregistrer -> PATCH .../settings/business-hours avec les 7 jours '0'..'6'.
    await page.getByTestId('param-save-hours').click();
    await expect.poll(() => patches.some((p) => p.url.includes('/settings/business-hours'))).toBe(true);
    const bh = patches.find((p) => p.url.includes('/settings/business-hours'))!.body.businessHours as Record<string, unknown>;
    expect(Object.keys(bh).sort()).toEqual(['0', '1', '2', '3', '4', '5', '6']);
  });
});
