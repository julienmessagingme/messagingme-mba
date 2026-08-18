import { test, expect } from '@playwright/test';

/**
 * E2E détail de campagne : ce qui a été envoyé, et quand. Une campagne SCÉNARIO n'a pas de template propre,
 * et l'écran affichait « template () ». Ce spec reproduit le symptôme puis l'interdit, et vérifie la colonne
 * « Envoyé le » (la date était déjà en mémoire côté navigateur, simplement jamais rendue).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const counts = { total: 3, pending: 1, sending: 0, sent: 1, failed: 1, skipped: 0 };
const CAMPAIGNS = [
  { id: 'c-tpl', name: 'Promo été', category: 'marketing', status: 'completed', phoneNumberId: 'pn1', templateName: 'promo_ete', templateLanguage: 'fr', workflowName: null, createdAt: '2026-08-10T09:00:00.000Z', scheduledAt: null, archivedAt: null, counts },
  { id: 'c-wf', name: 'Relance', category: 'marketing', status: 'completed', phoneNumberId: 'pn1', templateName: null, templateLanguage: null, workflowName: 'Relance promo', createdAt: '2026-08-10T09:00:00.000Z', scheduledAt: null, archivedAt: null, counts },
  { id: 'c-orphan', name: 'Ancienne', category: 'marketing', status: 'completed', phoneNumberId: 'pn1', templateName: null, templateLanguage: null, workflowName: null, createdAt: '2026-08-10T09:00:00.000Z', scheduledAt: null, archivedAt: null, counts },
];

// Un envoyé (date fixe -> rendu déterministe, day.ts impose Europe/Paris), un en attente, un en échec renvoyable.
const DETAIL_WF = {
  ...CAMPAIGNS[1],
  paramMapping: [],
  recipients: [
    { id: 'r1', contactId: 'ct1', toE164: '+33611111111', status: 'sent', messageId: 'm-1', error: null, errorCode: null, sentAt: '2026-08-10T09:05:00.000Z', deliveryStatus: 'delivered', deliveryError: null },
    { id: 'r2', contactId: 'ct2', toE164: '+33622222222', status: 'pending', messageId: null, error: null, errorCode: null, sentAt: null, deliveryStatus: null, deliveryError: null },
    { id: 'r3', contactId: 'ct3', toE164: '+33633333333', status: 'failed', messageId: null, error: '132012 bad params', errorCode: 132012, sentAt: null, deliveryStatus: null, deliveryError: null },
  ],
};

test.describe('Campagnes : ce qui a été envoyé + la date', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/campaigns/c-wf')) return json(DETAIL_WF);
      if (url.includes('/campaigns')) return json({ campaigns: CAMPAIGNS });
      if (url.includes('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33500000000', verifiedName: 'Test' }] });
      if (url.includes('/templates')) return json({ templates: [] });
      if (url.endsWith('/workflows')) return json({ workflows: [] });
      if (url.includes('/user-fields')) return json({ fields: [] });
      if (url.includes('/tags')) return json({ tags: [] });
      if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/campaigns');
  });

  test('la liste ne dit jamais « template () » et nomme le scénario', async ({ page }) => {
    await expect(page.getByText('Template « promo_ete » (fr)')).toBeVisible();
    await expect(page.getByText('Scénario « Relance promo »')).toBeVisible();
    await expect(page.getByText('Scénario supprimé')).toBeVisible();
    // L'assertion qui reproduit puis interdit le bug rapporté.
    await expect(page.getByText(/template\s*\(\s*\)/i)).toHaveCount(0);
  });

  test('le détail nomme le scénario et donne la date d envoi de chaque destinataire', async ({ page }) => {
    await page.getByRole('button', { name: /Détails/i }).nth(1).click();

    // L'en-tête du panneau dit lui-même ce qui a été envoyé.
    await expect(page.getByText('Scénario « Relance promo »').nth(1)).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Envoyé le' })).toBeVisible();

    // Envoyé : la date, au fuseau Europe/Paris (09:05 UTC -> 11:05).
    await expect(page.getByText('10/08/26 11:05')).toBeVisible();
    // Non envoyé : un libellé explicite, jamais une case vide ni « Invalid Date ».
    await expect(page.getByText('non envoyé').first()).toBeVisible();
    await expect(page.getByText(/Invalid Date/i)).toHaveCount(0);
    await expect(page.getByText(/template\s*\(\s*\)/i)).toHaveCount(0);
  });

  test('le formulaire « Corriger + renvoyer » couvre toute la largeur (colSpan suit la 5e colonne)', async ({ page }) => {
    await page.getByRole('button', { name: /Détails/i }).nth(1).click();
    await page.getByTestId('retry-r3').click();
    const cell = page.locator('td[colspan]');
    await expect(cell).toHaveAttribute('colspan', '5');
  });
});
