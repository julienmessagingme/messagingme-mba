import { test, expect } from '@playwright/test';

/**
 * Canal RCS dans l'assistant de création de campagne : choisir « Un message RCS » remplace le numéro Meta par
 * un agent de marque, et le sélecteur de template par une zone de message. Sans agent configuré, l'assistant
 * le DIT au lieu de proposer un canal inutilisable.
 *
 * Ce qui est vérifié AILLEURS, à dessein : le corps réellement posté (`channel: 'rcs'`, agent, message, et
 * l'absence de phoneNumberId) est contrôlé au niveau de la route par `tests/http-campaigns-rcs.test.ts`, qui
 * lit l'input de création exact. Le rejouer ici en pilotant tout l'assistant coûterait cher pour la même
 * garantie.
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
    if (url.includes('/settings')) return json({ hubspotListsEnabled: false, campaignsPaused: false, mbaEnabled: false, rcsEnabled: agents.length > 0 });
    if (url.includes('/contacts')) return json({ contacts: [{ id: 'c1', phoneE164: '+33611', profileName: 'A', fields: {}, tags: [], optInStatus: 'opted_in' }], total: 1 });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/campaigns')) return json({ campaigns: [] });
    return json({});
  });
}

test.describe('Campagnes : canal RCS', () => {
  test('sans agent depose, le canal RCS est VISIBLE mais eteint et non cliquable', async ({ page }) => {
    await mockCampagnes(page, [], []);
    await page.goto('/campaigns');
    await page.getByRole('button', { name: /ajouter une campagne/i }).first().click();
    await page.getByTestId('campaign-name').fill('Promo RCS');

    // Le canal reste montré (on prépare son projet), mais il ne peut pas être choisi tant qu'aucun agent
    // n'est déposé : rien ne partirait. Les deux autres canaux, eux, restent cliquables.
    const rcs = page.getByTestId('campaign-mode-rcs');
    await expect(rcs).toBeVisible();
    await expect(rcs).toBeDisabled();
    await expect(page.getByTestId('campaign-mode-template')).toBeEnabled();
  });

  test('choisir le canal RCS remplace le numero Meta par un agent et le template par un message', async ({ page }) => {
    await mockCampagnes(page, [], [{ agentId: 'agent-1', brandName: 'MessagingMe', status: 'launched' }]);
    await page.goto('/campaigns');
    await page.getByRole('button', { name: /ajouter une campagne/i }).first().click();
    // Nommer la campagne est un préalable : sans nom, la zone Message reste grisée.
    await page.getByTestId('campaign-name').fill('Promo RCS');

    await page.getByTestId('campaign-mode-rcs').click();

    // L'expéditeur devient un agent de marque, pas un numéro.
    await expect(page.getByTestId('rcs-agent-select')).toBeVisible();
    await expect(page.getByText('+33600000000')).toHaveCount(0);

    // Le contenu devient une zone de message, sans sélecteur de template.
    await expect(page.getByTestId('rcs-message')).toBeVisible();
  });
});
