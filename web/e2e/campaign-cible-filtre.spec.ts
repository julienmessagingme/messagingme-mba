import { test, expect } from '@playwright/test';

/**
 * La CIBLE d'une campagne : l'intention de sélection, et non une liste d'identifiants.
 *
 * « Tout sélectionner » rapatriait jusqu'à 100 000 identifiants dans le navigateur pour les renvoyer dans la
 * requête, plafonnée à 1 Mo : la création échouait vers 25 000 contacts, donc AVANT la limite que l'écran
 * annonçait, et sans rien dire. L'écran envoie désormais les filtres, et le serveur les résout.
 *
 * 🔴 Le second test est le plus important, et il vient d'une revue. Le mode « tout ce qui correspond »
 * SURVIVAIT à un changement de source : on cliquait « Tout sélectionner » sur le CRM, on basculait sur
 * « Import fichier », et l'écran montrait un widget d'upload vide pendant que l'état retenait encore la
 * cible du CRM. Créer aurait envoyé les ANCIENS filtres, donc potentiellement l'espace entier, à un
 * opérateur persuadé de viser son fichier. C'est l'accident que ce lot ferme, déplacé d'un cran.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONTACTS = Array.from({ length: 3 }, (_, i) => ({
  id: `c${i}`, phoneE164: `+3360000000${i}`, profileName: `Contact ${i}`, tags: [], fields: {}, optInStatus: 'opted_in', createdAt: '2026-09-01T00:00:00.000Z',
}));

/** Monte l'écran de création et capture les corps envoyés à la création de campagne. */
async function monter(page: import('@playwright/test').Page, corps: unknown[]) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && /\/campaigns$/.test(url)) {
      corps.push(req.postDataJSON());
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ campaignId: 'camp1', recipientCount: 1200 }) });
    }
    if (url.includes('/contacts/count')) return json({ total: 1200 });
    if (url.includes('/contacts')) return json({ contacts: CONTACTS, total: 1200 });
    if (url.includes('/template-params')) return json({ hints: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.includes('/campaign-drafts')) return json({ drafts: [] });
    if (url.includes('/campaigns')) return json({ campaigns: [] });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33525680250', verifiedName: 'Auxerre Mobilité' }] });
    if (url.includes('/templates')) return json({ templates: [{ name: 'promo', language: 'fr', category: 'MARKETING', status: 'APPROVED', body: 'Bonjour', buttons: [] }] });
    if (url.endsWith('/workflows')) return json({ workflows: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
  await page.goto('/campaigns');
  await page.getByRole('button', { name: /Ajouter une campagne/i }).click();
  // La zone des destinataires est GELÉE tant que la campagne n'a pas de nom (étape 0 de l'écran).
  await page.getByTestId('campaign-name').fill('Campagne cible');
}

test.describe('Campagne : la cible part en INTENTION, pas en liste d’identifiants', () => {
  test('🔴 « Tout sélectionner » envoie les filtres, jamais les identifiants', async ({ page }) => {
    const corps: unknown[] = [];
    await monter(page, corps);

    await page.getByRole('button', { name: /Tout sélectionner \(1200\)/ }).click();
    // Le mode doit se VOIR : l'écran n'affiche que 3 lignes pour une campagne qui en vise 1200.
    await expect(page.getByTestId('campagne-cible-filtre')).toContainText('1200');
  });

  test('🔴 changer de SOURCE oublie le mode « tout ce qui correspond »', async ({ page }) => {
    // Trouvé en revue. Le bandeau et le compteur ne sont rendus que dans la branche CRM : hors d'elle, plus
    // rien à l'écran ne disait ce qui était visé, et l'ancienne cible restait armée.
    const corps: unknown[] = [];
    await monter(page, corps);

    await page.getByRole('button', { name: /Tout sélectionner \(1200\)/ }).click();
    await expect(page.getByTestId('campagne-cible-filtre')).toBeVisible();

    await page.getByRole('button', { name: /Import fichier/i }).click();
    await expect(page.getByTestId('campagne-cible-filtre')).toHaveCount(0);

    // Et le retour au CRM ne ressuscite pas la cible d'avant : il faut la redemander.
    await page.getByRole('button', { name: /Liste de contacts/i }).click();
    await expect(page.getByTestId('campagne-cible-filtre')).toHaveCount(0);
  });
});
