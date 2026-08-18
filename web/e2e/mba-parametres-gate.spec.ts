import { test, expect } from '@playwright/test';
import { mockMba } from './support/mba';

/**
 * Ce qui bloque la configuration, et ce que l'écran en dit. Deux motifs distincts qui ne se règlent pas au même
 * endroit : aucun numéro rattaché, et numéro pas encore ouvert par Meta. Les confondre envoie le client
 * chercher au mauvais endroit.
 */
test.describe('MBA Paramètres : blocages', () => {
  test('aucun numéro rattaché : message dédié, aucun onglet', async ({ page }) => {
    await mockMba(page, { account: { hasNumber: false, phoneNumberId: null } });
    await page.goto('/mba/parametres');
    await expect(page.getByTestId('mba-gate-no-number')).toBeVisible();
    await expect(page.getByTestId('mba-tab-apercu')).toHaveCount(0);
  });

  test('numéro pas encore ouvert par Meta : bannière, aucun onglet', async ({ page }) => {
    await mockMba(page, { status: { eligible: false, onboarded: false, agentId: null, settings: null } });
    await page.goto('/mba/parametres');
    await expect(page.getByTestId('mba-gate-not-eligible')).toBeVisible();
    await expect(page.getByTestId('mba-tab-faq')).toHaveCount(0);
  });

  test('numéro ouvert : les 7 onglets sont là, et PAS d’onglet pour les numéros de test', async ({ page }) => {
    await mockMba(page);
    await page.goto('/mba/parametres');
    for (const cle of ['apercu', 'business', 'faq', 'competences', 'fichiers', 'sites', 'test']) {
      await expect(page.getByTestId(`mba-tab-${cle}`), cle).toBeVisible();
    }
    // La liste d'autorisation n'est PAS une étape de configuration : elle vit dans la vue d'ensemble, sous le
    // choix d'audience, parce qu'elle n'a de sens que par rapport à lui.
    await expect(page.getByTestId('mba-tab-allowlist')).toHaveCount(0);
    await expect(page.getByTestId('mba-gate-not-eligible')).toHaveCount(0);
  });

  test('l’onglet est adressable par l’URL', async ({ page }) => {
    await mockMba(page, { faqs: [{ id: '1', question: 'Horaires ?', answer: '6h-21h' }] });
    await page.goto('/mba/parametres?tab=faq');
    await expect(page.getByTestId('mba-faq-count')).toContainText('1');
  });
});
