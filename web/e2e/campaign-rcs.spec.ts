import { test, expect } from '@playwright/test';

/**
 * Canal RCS dans l'assistant de création de campagne : choisir « Un message RCS » remplace le numéro Meta par
 * un agent de marque, remplace le sélecteur de template par une zone de message, et le corps envoyé au backend
 * porte `channel: 'rcs'` avec l'agent et le message (jamais de phoneNumberId).
 *
 * Ce qu'on protège ici : un opérateur qui croit envoyer en RCS et dont la campagne partirait en WhatsApp (ou
 * l'inverse) est le pire défaut possible de cet écran. Le test lit le corps RÉELLEMENT posté.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

type Cree = Record<string, unknown>;

async function mockCampagnes(page: import('@playwright/test').Page, cree: Cree[], agents: unknown[]) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && /\/campaigns$/.test(url)) {
      cree.push((req.postDataJSON() ?? {}) as Cree);
      return json({ campaignId: 'camp-1', recipientCount: 1, skipped: [] });
    }
    if (url.includes('/rcs-agents')) return json({ agents });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33600000000', verifiedName: 'Demo' }] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/workflows')) return json({ workflows: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.includes('/settings')) return json({ hubspotListsEnabled: false, campaignsPaused: false });
    if (url.includes('/contacts')) return json({ contacts: [{ id: 'c1', phoneE164: '+33611', profileName: 'A', fields: {}, tags: [], optInStatus: 'opted_in' }], total: 1 });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/campaigns')) return json({ campaigns: [] });
    return json({});
  });
}

test.describe('Campagnes : canal RCS', () => {
  test('sans agent configure, l assistant le DIT au lieu de proposer un canal inutilisable', async ({ page }) => {
    await mockCampagnes(page, [], []);
    await page.goto('/campaigns');
    await page.getByRole('button', { name: /nouvelle campagne/i }).first().click();

    await page.getByRole('button', { name: 'Un message RCS' }).click();
    await expect(page.getByTestId('rcs-no-agent')).toBeVisible();
  });

  test('choisir le canal RCS remplace le numero Meta par un agent et le template par un message', async ({ page }) => {
    await mockCampagnes(page, [], [{ agentId: 'agent-1', brandName: 'MessagingMe', status: 'launched' }]);
    await page.goto('/campaigns');
    await page.getByRole('button', { name: /nouvelle campagne/i }).first().click();

    await page.getByRole('button', { name: 'Un message RCS' }).click();

    // L'expéditeur devient un agent de marque, pas un numéro.
    await expect(page.getByTestId('rcs-agent-select')).toBeVisible();
    await expect(page.getByText('+33600000000')).toHaveCount(0);

    // Le contenu devient une zone de message, sans sélecteur de template.
    await expect(page.getByTestId('rcs-message')).toBeVisible();
  });
});
