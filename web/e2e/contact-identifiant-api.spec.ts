import { test, expect } from '@playwright/test';
import { TREIZE_POUCES } from './aide/largeur';

/**
 * L'IDENTIFIANT DE FICHE SUR LA FICHE DU MINI-CRM (spec de l'API publique, § 10).
 *
 * 🔴 C'EST LA VALEUR QUE L'API APPELLE `contactId` : un intégrateur qui cherche « quel identifiant passer ? »
 * doit la trouver là où il regarde la personne, et la copier sans la ressaisir. L'identifiant externe
 * s'affiche quand il existe, et sa ligne DISPARAÎT quand il n'existe pas (une ligne vide se lirait « à
 * remplir », alors qu'il ne se remplit que par l'API).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const BASE = { bsuid: null, optInStatus: 'opted_in', tags: [], fields: {}, createdAt: '2026-01-01T00:00:00Z', whatsappJoignable: null, whatsappJoignableLe: null };
const AVEC = { ...BASE, id: '5f0c1b2e-7d4a-4c8e-9b1a-2f3e4d5c6b7a', profileName: 'Camille Externe', phoneE164: '+33600000011', externalId: 'crm-7781' };
const SANS = { ...BASE, id: '8a9b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d', profileName: 'Bruno Interne', phoneE164: '+33600000012', externalId: null };
const CONTACTS = [AVEC, SANS];

async function mock(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = route.request().url().split('?')[0]!;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/conversations/todo-count')) return json({ count: 0 });
    if (chemin.endsWith('/contacts')) return json({ contacts: CONTACTS, total: CONTACTS.length });
    if (chemin.endsWith('/user-fields')) return json({ fields: [] });
    if (chemin.endsWith('/tags')) return json({ tags: [] });
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Fiche contact : identifiant API et identifiant externe', () => {
  test.use({ viewport: TREIZE_POUCES, permissions: ['clipboard-read', 'clipboard-write'] });

  test('🔴 la fiche montre l’identifiant que l’API appelle contactId, et le copie', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');
    await page.getByText('Camille Externe').first().click();
    await expect(page.getByTestId('fiche-identifiant-api')).toHaveText(AVEC.id);
    await page.getByTestId('fiche-copier-identifiant').click();
    await expect(page.getByTestId('fiche-copier-identifiant')).toHaveText('Copié');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(AVEC.id);
  });

  test('⚠️ une copie refusée par le navigateur le DIT, au lieu de ne rien faire', async ({ page }) => {
    // Presse-papiers qui refuse (contexte non sécurisé, navigateur restrictif) : sans retour, on recliquerait
    // en croyant que rien ne s'est passé.
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'clipboard', {
        configurable: true,
        get: () => ({ writeText: () => Promise.reject(new Error('refusé')) }),
      });
    });
    await mock(page);
    await page.goto('/contacts');
    await page.getByText('Camille Externe').first().click();
    await page.getByTestId('fiche-copier-identifiant').click();
    await expect(page.getByTestId('fiche-copier-identifiant')).toHaveText('Copie impossible');
  });

  test('l’identifiant externe s’affiche quand la fiche en porte un', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');
    await page.getByText('Camille Externe').first().click();
    await expect(page.getByTestId('fiche-identifiant-externe')).toHaveText('crm-7781');
  });

  test('⚠️ une fiche sans identifiant externe n’affiche pas de ligne vide', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');
    await page.getByText('Bruno Interne').first().click();
    await expect(page.getByTestId('fiche-identifiant-api')).toHaveText(SANS.id);
    await expect(page.getByTestId('fiche-identifiant-externe')).toHaveCount(0);
  });
});
