import { test, expect } from '@playwright/test';
import { mockMba } from './support/mba';

/** SONDE TEMPORAIRE (à supprimer) : mesure la marge réelle du test de course. */

const CSV = 'question,réponse\nLes vélos ?,Pliants uniquement.\nHoraires ?,6h-22h en été\n';
const APERCU = {
  source: 'csv',
  total: 3,
  aCreer: [{ question: 'Les vélos ?', answer: 'Pliants uniquement.' }],
  aMettreAJour: [{ id: '2', question: 'Horaires ?', answer: '6h-22h en été' }],
  inchangees: 1,
};

for (const n of [1, 2, 3, 4, 5]) {
  test(`sonde marge #${n}`, async ({ page }) => {
    let analyses = 0;
    let tReq = 0;
    await mockMba(page, {
      custom: async (route, method, url) => {
        if (method === 'POST' && url.includes('/faq/preview')) {
          analyses += 1;
          tReq = Date.now();
          await new Promise((r) => setTimeout(r, 1200));
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(APERCU) });
          return true;
        }
        return false;
      },
    });
    await page.goto('/mba/parametres?tab=faq');
    await page.getByTestId('mba-faq-import-open').click();

    await page.getByTestId('mba-import-csv').fill(CSV);
    const tAvantClic = Date.now();
    await page.getByTestId('mba-import-analyse').click();
    const tApresClic = Date.now();
    await page.getByTestId('mba-import-csv').fill(`${CSV}Les poussettes ?,Pliées.\n`);
    const tApresFrappe = Date.now();

    await expect.poll(() => analyses, { timeout: 8000 }).toBe(1);
    const tPoll = Date.now();

    // Instant où `setBusy(false)` est rendu. Dans la version BUGGÉE, `setSource`/`setApercu` sont dans la même
    // continuation que le `finally`, donc rendus dans le MÊME lot React : c'est l'instant où l'aperçu
    // réapparaîtrait. On le mesure sans toucher au composant.
    await page.waitForFunction(
      () => !(document.querySelector('[data-testid="mba-import-analyse"]') as HTMLButtonElement | null)?.disabled,
      undefined,
      { timeout: 15000 },
    );
    const tRendu = Date.now();

    const tAssertions = tPoll + 1500;
    console.log(
      `SONDE#${n} clic=${tApresClic - tAvantClic}ms frappe=${tApresFrappe - tApresClic}ms ` +
        `req->poll=${tPoll - tReq}ms req->rendu=${tRendu - tReq}ms ` +
        `MARGE(assertions - rendu)=${tAssertions - tRendu}ms`,
    );
  });
}
