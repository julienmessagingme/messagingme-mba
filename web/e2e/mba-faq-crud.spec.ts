import { test, expect } from '@playwright/test';
import { mockMba, appelsMba } from './support/mba';

const FAQS = [
  { id: '1', question: 'Les chiens sont-ils admis ?', answer: 'Oui, tenus en laisse.' },
  { id: '2', question: 'Horaires ?', answer: '6h-21h' },
];

test.describe('MBA Paramètres : FAQ une par une', () => {
  test('crée une question', async ({ page }) => {
    const calls = await mockMba(page, { faqs: FAQS });
    await page.goto('/mba/parametres?tab=faq');
    await expect(page.getByTestId('mba-faq-count')).toContainText('2');

    await page.getByTestId('mba-faq-new').click();
    await page.getByTestId('mba-faq-question').fill('Les vélos sont-ils acceptés ?');
    await page.getByTestId('mba-faq-answer').fill('Uniquement pliants et rangés.');
    await page.getByTestId('mba-faq-save').click();

    await expect.poll(() => appelsMba(calls, 'POST', '/faq')[0]?.body)
      .toEqual({ question: 'Les vélos sont-ils acceptés ?', answer: 'Uniquement pliants et rangés.' });
  });

  test('modifie une question (les DEUX champs repartent, le schéma Meta l’exige)', async ({ page }) => {
    const calls = await mockMba(page, { faqs: FAQS });
    await page.goto('/mba/parametres?tab=faq');
    await page.getByRole('button', { name: /Modifier|Edit/ }).first().click();
    await page.getByTestId('mba-faq-answer').fill('Oui, tenus en laisse et muselés.');
    await page.getByTestId('mba-faq-save').click();

    await expect.poll(() => appelsMba(calls, 'PUT', '/faq/1')[0]?.body)
      .toEqual({ question: 'Les chiens sont-ils admis ?', answer: 'Oui, tenus en laisse et muselés.' });
  });

  test('🔴 la suppression demande confirmation, et n’appelle rien si on refuse', async ({ page }) => {
    // Chez Meta un DELETE est irréversible : ni corbeille, ni archivage, ni annulation.
    const calls = await mockMba(page, { faqs: FAQS });
    await page.goto('/mba/parametres?tab=faq');

    page.once('dialog', (d) => void d.dismiss());
    await page.getByRole('button', { name: /Supprimer|Delete/ }).first().click();
    await expect.poll(() => appelsMba(calls, 'DELETE', '/faq/').length).toBe(0);

    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: /Supprimer|Delete/ }).first().click();
    await expect.poll(() => appelsMba(calls, 'DELETE', '/faq/1').length).toBe(1);
  });

  test('la recherche filtre côté client (l’API n’offre ni filtre ni tri)', async ({ page }) => {
    await mockMba(page, { faqs: FAQS });
    await page.goto('/mba/parametres?tab=faq');
    await page.getByTestId('mba-faq-search').fill('vélo');
    await expect(page.getByTestId('mba-faq-list')).toContainText(/Aucune question ne correspond|No question matches/);
    await page.getByTestId('mba-faq-search').fill('chien');
    await expect(page.getByTestId('mba-faq-list')).toContainText('laisse');
  });
});
