import { test, expect } from '@playwright/test';

/**
 * E2E inbox : le filtre « À traiter » ne montre que les conversations que le scénario ne gère plus
 * (control_owner != app_workflow : opérateur, node inbox escaladé, ou MBA). Backend intercepté (pattern accueil).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const CONVERSATIONS = [
  { id: 'c1', waId: '33600000001', profileName: 'Alice Auto', lastPreview: 'gérée par le scénario', lastMessageAt: '2026-08-02T10:00:00Z', controlOwner: 'app_workflow' },
  { id: 'c2', waId: '33600000002', profileName: 'Bob ATraiter', lastPreview: 'un humain doit répondre', lastMessageAt: '2026-08-02T11:00:00Z', controlOwner: 'app_human' },
];

test.describe('Inbox : filtre « À traiter »', () => {
  test('« À traiter » ne garde que les conversations hors app_workflow', async ({ page }) => {
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.endsWith('/conversations')) return json({ conversations: CONVERSATIONS });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await page.goto('/inbox');

    // Par défaut : les deux conversations sont visibles.
    await expect(page.getByText('Alice Auto')).toBeVisible();
    await expect(page.getByText('Bob ATraiter')).toBeVisible();

    // Filtre « À traiter » -> seule Bob (app_human) reste ; Alice (app_workflow) disparaît.
    await page.getByTestId('inbox-filter-todo').click();
    await expect(page.getByText('Bob ATraiter')).toBeVisible();
    await expect(page.getByText('Alice Auto')).toHaveCount(0);
  });
});
