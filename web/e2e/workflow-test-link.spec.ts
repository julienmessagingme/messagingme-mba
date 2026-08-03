import { test, expect } from '@playwright/test';

/**
 * E2E « Tester le scénario » (Lot F) : le menu d'un scénario propose un test, qui affiche le jeton, le lien
 * wa.me pré-rempli et son QR code (calculé dans le navigateur, aucun service externe).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const WF = { id: 'wf1', name: 'Prise de RDV', graph: { nodes: [], edges: [] }, createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z' };
// Jeton FICTIF (aucun secret) : valeur figée pour rendre les assertions lisibles.
const MOT_TEST = 'test-a7k2m9p3';

test.describe('Scénario : lien de test (QR + wa.me)', () => {
  test('le menu ouvre le panneau de test avec le jeton, le lien et le QR', async ({ page }) => {
    let posted = 0;
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (/\/workflows\/wf1\/test-link$/.test(url) && req.method() === 'POST') {
        posted += 1;
        return json({ token: MOT_TEST, phone: '+33 5 25 68 02 50', link: `https://wa.me/33525680250?text=${MOT_TEST}` });
      }
      if (url.endsWith('/workflows')) return json({ workflows: [WF] });
      if (url.endsWith('/settings')) return json({ mbaEnabled: false });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await page.goto('/workflows');

    await page.getByTestId('workflow-menu-wf1').click();
    await page.getByTestId('workflow-test-wf1').click();

    const panel = page.getByTestId('workflow-test-panel');
    await expect(panel).toBeVisible();
    expect(posted).toBe(1);

    // Le jeton et le lien pré-rempli sont montrés, et le QR est rendu en data-URL (calculé côté navigateur).
    await expect(panel.getByText(MOT_TEST)).toBeVisible();
    await expect(panel.locator('input[readonly]')).toHaveValue(`https://wa.me/33525680250?text=${MOT_TEST}`);
    await expect(panel.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  });
});
