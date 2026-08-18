import { test, expect } from '@playwright/test';
import { mockMba, appelsMba } from './support/mba';

test.describe('MBA Paramètres : bac à sable', () => {
  test('🔴 le fil de conversation est SUIVI d’un message à l’autre', async ({ page }) => {
    // Sans réutilisation du `conversation_id` rendu par Meta, chaque message repartirait de zéro et on ne
    // testerait jamais ce qui compte : la tenue d'un fil (« et pour les vélos ? » après « les chiens ? »).
    let n = 0;
    const calls = await mockMba(page, {
      custom: async (route, method, url) => {
        if (method === 'POST' && url.includes('/mba/') && url.endsWith('/test')) {
          n += 1;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ agent_response: `réponse ${n}`, conversation_id: 'conv-42' }),
          });
          return true;
        }
        return false;
      },
    });
    await page.goto('/mba/parametres?tab=test');

    await page.getByTestId('mba-test-input').fill('Les chiens sont-ils admis ?');
    await page.getByTestId('mba-test-send').click();
    await expect(page.getByTestId('mba-test-thread')).toContainText('réponse 1');
    expect(appelsMba(calls, 'POST', '/test')[0]?.body).toEqual({ message: 'Les chiens sont-ils admis ?' });

    await page.getByTestId('mba-test-input').fill('Et pour les vélos ?');
    await page.getByTestId('mba-test-send').click();
    await expect(page.getByTestId('mba-test-thread')).toContainText('réponse 2');
    await expect.poll(() => appelsMba(calls, 'POST', '/test')[1]?.body)
      .toEqual({ message: 'Et pour les vélos ?', conversationId: 'conv-42' });
  });

  test('le passage à un humain est signalé à l’écran', async ({ page }) => {
    await mockMba(page, { testReply: { agent_response: 'Je passe la main.', conversation_id: 'c1', handoff_reason: 'customer_request' } });
    await page.goto('/mba/parametres?tab=test');
    await page.getByTestId('mba-test-input').fill('Je veux parler à un conseiller.');
    await page.getByTestId('mba-test-send').click();
    await expect(page.getByTestId('mba-test-note')).toContainText('customer_request');
  });

  test('« nouvelle conversation » repart sans le fil précédent', async ({ page }) => {
    const calls = await mockMba(page);
    await page.goto('/mba/parametres?tab=test');
    await page.getByTestId('mba-test-input').fill('Bonjour');
    await page.getByTestId('mba-test-send').click();
    await expect(page.getByTestId('mba-test-thread')).toContainText('Bonjour');

    await page.getByTestId('mba-test-reset').click();
    await page.getByTestId('mba-test-input').fill('Rebonjour');
    await page.getByTestId('mba-test-send').click();
    await expect.poll(() => appelsMba(calls, 'POST', '/test').at(-1)?.body).toEqual({ message: 'Rebonjour' });
  });
});
