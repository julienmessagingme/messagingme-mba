import { test, expect } from '@playwright/test';
import { CODES_DOCUMENTES } from '../lib/api-exemples';
import { EVENEMENTS_SIGNAUX } from '../lib/signaux-dictionnaire';

/**
 * La page Documentation API, RENDUE.
 *
 * La suite racine (`tests/api-exemples.test.ts`) vérifie la SOURCE : exemples validés, aucun JSON écrit à
 * la main, aucun outil tiers nommé. Ici, on vérifie ce qu'un intégrateur VOIT : les familles de routes, la
 * section d'appel par contact, chaque code, et toujours aucun outil tiers dans le texte affiché.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

async function mock(page: import('@playwright/test').Page) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Developers : la documentation de l’API', () => {
  test('🔴 les familles de routes, l’appel par contact et chaque code sont à l’écran', async ({ page }) => {
    await mock(page);
    await page.goto('/developers/api');
    // Borné au CONTENU de la page : la barre latérale de la console a ses propres libellés.
    const doc = page.getByTestId('doc-api');
    for (const titre of [
      'Désigner une personne', 'Contacts', 'Envoyer un message simple', 'Déclencher un envoi',
      'Ce que vous pouvez envoyer', 'Brancher un outil qui appelle par contact', 'Erreurs', 'Exemples complets',
      // Lot 6 : la section des signaux, rendue DANS `doc-api`, donc lue aussi par le cas « aucun outil tiers ».
      'Ce que nous remontons',
    ]) {
      await expect(doc.getByRole('heading', { name: titre, exact: true })).toBeVisible();
    }
    for (const c of CODES_DOCUMENTES) await expect(doc.getByTestId(`code-${c.code}`)).toBeVisible();
    for (const e of EVENEMENTS_SIGNAUX) await expect(doc.getByTestId(`signal-${e.nom}`)).toBeVisible();
  });

  test('🔴 sans session, la doc est PUBLIQUE : elle s’affiche au lieu de renvoyer au login', async ({ page }) => {
    // Aucune session posée : c'est l'intégrateur qui arrive de la vitrine, sans compte. Avant le 2026-09-25,
    // la console le renvoyait sur /login.
    await page.route('**/api/backend/**', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
    await page.goto('/developers/api');
    const doc = page.getByTestId('doc-api');
    await expect(doc.getByRole('heading', { name: 'Documentation API', exact: true })).toBeVisible();
    await expect(doc.getByRole('heading', { name: 'Contacts', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/developers\/api$/);
    await expect(page.getByRole('link', { name: 'Se connecter' })).toBeVisible();
  });

  test('🔴 la page rendue ne nomme aucun outil tiers', async ({ page }) => {
    await mock(page);
    await page.goto('/developers/api');
    const doc = page.getByTestId('doc-api');
    await expect(doc.getByRole('heading', { name: 'Documentation API', exact: true })).toBeVisible();
    // ⚠️ Le CONTENU de la page, pas `body` : la barre latérale nomme d'autres écrans de la console (une
    // intégration CRM y a sa page), ce qui ferait échouer ce cas pour une raison étrangère à la doc.
    const texte = await doc.innerText();
    expect(texte).not.toMatch(/(?<![/\w])batch(?!\w)/i);
    expect(texte).not.toMatch(/custom_id|Universal Channel|Brevo|Salesforce|Splio|HubSpot|Klaviyo|Braze|Zapier|smsmode/i);
  });
});
