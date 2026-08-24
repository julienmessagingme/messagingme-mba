import { test, expect } from '@playwright/test';

/**
 * Accueil : activation du canal RCS, sous le numéro WhatsApp.
 *
 * Ce qu'on protège : la clé ne doit JAMAIS réapparaître à l'écran, et un refus du fournisseur doit être
 * affiché avec sa raison. Sans ça, l'opérateur croit avoir activé le canal et ne le découvre qu'au premier
 * envoi raté.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

async function mock(page: import('@playwright/test').Page, opts: { post?: { status: number; body: unknown } } = {}) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/rcs/channel')) {
      if (req.method() === 'POST') {
        const r = opts.post ?? { status: 200, body: { active: true, channel: { channelId: 'ch', name: 'CANAL RCS', agentName: 'MessagingMe', flow: 'MARKETING', dailyLimit: 500, dailyUsed: 0, monthlyLimit: 300, monthlyUsed: 0 } } };
        return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
      }
      return json({ active: false });
    }
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean', role: 'admin' });
    return json({});
  });
}

test.describe('Accueil : canal RCS', () => {
  test('active le canal et n affiche JAMAIS la cle saisie', async ({ page }) => {
    await mock(page);
    await page.goto('/accueil');

    const carte = page.getByTestId('rcs-channel-card');
    await expect(carte).toBeVisible();
    await expect(carte).toContainText('inactif');

    await page.getByTestId('rcs-channel-activate').click();
    await page.getByTestId('rcs-channel-key').fill('ma-cle-secrete');
    await page.getByTestId('rcs-channel-submit').click();

    // Ce qui s'affiche, c'est ce que la cle OUVRE, jamais la cle.
    await expect(carte).toContainText('MARKETING');
    await expect(page.locator('body')).not.toContainText('ma-cle-secrete');
  });

  test('affiche la RAISON quand le fournisseur refuse la cle', async ({ page }) => {
    await mock(page, {
      post: { status: 422, body: { error: 'Cette clé ne donne pas accès à un canal RCS (canaux vus : SMS).', reason: 'no_rcs_channel' } },
    });
    await page.goto('/accueil');

    await page.getByTestId('rcs-channel-activate').click();
    await page.getByTestId('rcs-channel-key').fill('cle-de-canal-sms');
    await page.getByTestId('rcs-channel-submit').click();

    await expect(page.getByTestId('rcs-channel-error')).toContainText('SMS');
  });
});
