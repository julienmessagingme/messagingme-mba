import { test, expect } from '@playwright/test';

/**
 * Les deux étapes de CLIC du funnel par campagne (Analytics > Quantitatif).
 *
 * Ce qu'elles doivent dire, et surtout ce qu'elles ne doivent PAS dire : une étape à zéro sur un template
 * sans bouton se lirait « personne n'a cliqué » alors que la vérité est « il n'y a rien à cliquer ». D'où le
 * `null` côté serveur, distinct du zéro.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const CAMPAGNE = {
  id: 'camp1', name: 'Promo été', status: 'completed', templateName: 'promo', templateLanguage: 'fr',
  workflowName: null, createdAt: '2026-08-20T10:00:00.000Z',
};

async function monter(page: import('@playwright/test').Page, funnel: Record<string, unknown>) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/stats/campaign-funnel')) return json(funnel);
    if (url.includes('/campaigns')) return json({ campaigns: [CAMPAGNE] });
    // Les formes attendues par le reste du tableau de bord (mêmes fixtures que `exports.spec.ts`) : un `{}`
    // suffit à faire tomber TOUT l'écran, et la carte du funnel avec lui.
    if (url.includes('/stats/conversations')) return json({});
    if (url.includes('/stats/templates')) return json({ total: 0, breakdown: [], pricing: { byCategory: {}, totalCost: 0, currency: 'EUR' } });
    if (url.includes('/stats/errors')) return json({ errors: [] });
    if (url.includes('/stats/cost')) return json({ marketing: [], utility: [], total: 0, hasRates: true, currency: 'EUR' });
    if (url.includes('/stats')) return json({ contacts: [], templates: { utility: [], marketing: [] }, exchanged: [], service: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
  await page.goto('/dashboard');
  await expect(page.locator('#quanti-funnel')).toBeVisible();
}

const BASE = { sent: 100, delivered: 90, read: 60, replied: 12, failed: 2 };

test.describe('Funnel par campagne : les étapes de clic', () => {
  test('🔴 un template SANS lien tracé n’affiche PAS l’étape des clics', async ({ page }) => {
    // `urlClicks: null` = rien à cliquer. Une barre à zéro serait une accusation contre les destinataires.
    await monter(page, { ...BASE, buttonReplies: 0, urlClicks: null });
    const carte = page.locator('#quanti-funnel');
    await expect(carte).toContainText(/Envoyés|Sent/);
    await expect(carte).not.toContainText(/Clics sur le lien|Link clicks/);
    await expect(carte).not.toContainText(/tapé un bouton|tapped a button/);
  });

  test('🔴 avec des liens tracés, l’étape apparaît MÊME à zéro', async ({ page }) => {
    // Là, le zéro est une information : le lien existe, personne n'a cliqué.
    await monter(page, { ...BASE, buttonReplies: 0, urlClicks: 0 });
    await expect(page.locator('#quanti-funnel')).toContainText(/Clics sur le lien|Link clicks/);
  });

  test('🔴 les deux étapes affichent leur valeur, avec des libellés d’UNITÉS distinctes', async ({ page }) => {
    // Les taps comptent des PERSONNES, les clics de lien comptent des CLICS. Confondre les deux ferait lire
    // un taux là où il n'y en a pas.
    await monter(page, { ...BASE, buttonReplies: 30, urlClicks: 45 });
    const carte = page.locator('#quanti-funnel');
    await expect(carte).toContainText(/Destinataires ayant tapé un bouton|Recipients who tapped a button/);
    await expect(carte).toContainText(/Clics sur le lien \(total\)|Link clicks \(total\)/);
    await expect(carte).toContainText('30');
    await expect(carte).toContainText('45');
  });

  test('🔴 plus de clics que d’envois ne déborde pas et n’affiche AUCUN pourcentage', async ({ page }) => {
    // Une même personne peut cliquer dix fois : le total n'est pas borné par les envois. Sans plafond la
    // barre sortait de sa piste, et un pourcentage aurait annoncé « 300 % ont cliqué ».
    await monter(page, { ...BASE, buttonReplies: 0, urlClicks: 300 });
    const carte = page.locator('#quanti-funnel');
    await expect(carte).toContainText('300');
    await expect(carte).not.toContainText('300 %');
    await expect(carte).not.toContainText('300%');
    // Aucune barre ne dépasse sa piste.
    const debordement = await carte.locator('div[style*="width"]').evaluateAll(
      (els) => els.some((e) => Number.parseFloat((e as HTMLElement).style.width) > 100),
    );
    expect(debordement, 'une barre dépasse 100 % de largeur').toBe(false);
  });
});
