import { test, expect } from '@playwright/test';
import { mockMba, appelsMba } from './support/mba';

/** SONDE TEMPORAIRE (à supprimer) : dérive B, corps du test de course à l'identique, réponse à 1900 ms. */

const CSV = 'question,réponse\nLes vélos ?,Pliants uniquement.\nHoraires ?,6h-22h en été\n';
const APERCU = {
  source: 'csv',
  total: 3,
  aCreer: [{ question: 'Les vélos ?', answer: 'Pliants uniquement.' }],
  aMettreAJour: [{ id: '2', question: 'Horaires ?', answer: '6h-22h en été' }],
  inchangees: 1,
};

test('dérive B : les 4 assertions sont évaluées AVANT le retour de la réponse', async ({ page }) => {
  let analyses = 0;
  let repondu = false;
  const calls = await mockMba(page, {
    custom: async (route, method, url) => {
      if (method === 'POST' && url.includes('/faq/preview')) {
        analyses += 1;
        await new Promise((r) => setTimeout(r, 1900)); // 1200 nominal + 700 de dérive
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(APERCU) });
        repondu = true;
        return true;
      }
      return false;
    },
  });
  await page.goto('/mba/parametres?tab=faq');
  await page.getByTestId('mba-faq-import-open').click();

  await page.getByTestId('mba-import-csv').fill(CSV);
  await page.getByTestId('mba-import-analyse').click();
  await page.getByTestId('mba-import-csv').fill(`${CSV}Les poussettes ?,Pliées.\n`);

  await expect.poll(() => analyses, { timeout: 8000 }).toBe(1);
  await page.waitForTimeout(1500);

  // Les 4 assertions du test réel, dans le même ordre.
  await expect(page.getByTestId('mba-import-preview')).toHaveCount(0);
  const reponduA1 = repondu;
  await expect(page.getByTestId('mba-import-confirm')).toBeDisabled();
  const reponduA2 = repondu;
  expect(appelsMba(calls, 'POST', '/faq/import')).toHaveLength(0);
  await expect(page.getByTestId('mba-import-analyse')).toBeEnabled();
  const reponduA4 = repondu;

  console.log(`DERIVE reponduApresA1=${reponduA1} reponduApresA2=${reponduA2} reponduApresA4=${reponduA4}`);
});
