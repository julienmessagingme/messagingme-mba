import { test, expect } from '@playwright/test';
import { mockMba, appelsMba } from './support/mba';

/**
 * Le chargement en lot. C'est la pièce la plus délicate de l'écran, parce que l'API Meta n'a NI suppression en
 * lot NI corbeille : un import raté se rattrape entrée par entrée, à la main.
 */

const CSV = 'question,réponse\nLes vélos ?,Pliants uniquement.\nHoraires ?,6h-22h en été\n';
const APERCU = {
  source: 'csv',
  total: 3,
  aCreer: [{ question: 'Les vélos ?', answer: 'Pliants uniquement.' }],
  aMettreAJour: [{ id: '2', question: 'Horaires ?', answer: '6h-22h en été' }],
  inchangees: 1,
};

test.describe('MBA Paramètres : import de FAQ', () => {
  test('🔴 aucun import possible tant qu’un aperçu n’a pas été rendu', async ({ page }) => {
    const calls = await mockMba(page, { preview: APERCU });
    await page.goto('/mba/parametres?tab=faq');
    await page.getByTestId('mba-faq-import-open').click();

    await page.getByTestId('mba-import-csv').fill(CSV);
    await expect(page.getByTestId('mba-import-confirm')).toBeDisabled();
    expect(appelsMba(calls, 'POST', '/faq/import')).toHaveLength(0);
  });

  test('analyse puis confirmation : les trois catégories, puis l’écriture', async ({ page }) => {
    const calls = await mockMba(page, {
      preview: APERCU,
      importResult: { source: 'csv', created: 1, updated: 1, unchanged: 1, remaining: 0, ids: { created: ['f9'], updated: ['2'] }, failed: null },
    });
    await page.goto('/mba/parametres?tab=faq');
    await page.getByTestId('mba-faq-import-open').click();
    await page.getByTestId('mba-import-csv').fill(CSV);
    await page.getByTestId('mba-import-analyse').click();

    await expect(page.getByTestId('mba-import-summary')).toContainText('1 à créer');
    await expect(page.getByTestId('mba-import-summary')).toContainText('1 à mettre à jour');
    await expect(page.getByTestId('mba-import-summary')).toContainText('1 inchangée');
    await expect(page.getByTestId('mba-import-tocreate')).toContainText('Les vélos ?');

    await page.getByTestId('mba-import-confirm').click();
    await expect(page.getByTestId('mba-import-result')).toContainText('1 créée');
    expect(appelsMba(calls, 'POST', '/faq/import')).toHaveLength(1);

    // 🔴 L'INVARIANT du panneau : ce qui est écrit est EXACTEMENT ce qui a été analysé. Compter les appels ne
    // prouve rien de leur contenu ; sans cette comparaison, une charge fabriquée au moment du clic passerait.
    const analysee = appelsMba(calls, 'POST', '/faq/preview')[0]?.body;
    const ecrite = appelsMba(calls, 'POST', '/faq/import')[0]?.body;
    expect(ecrite).toEqual(analysee);
    expect(ecrite).toEqual({ csv: CSV });
  });

  test('🔴 la charge importée est EXACTEMENT celle prévisualisée', async ({ page }) => {
    // Sans cet invariant, modifier le texte après l'aperçu puis cliquer Confirmer écrirait chez Meta quelque
    // chose que personne n'a jamais vu. Ici : on analyse, on modifie, et l'aperçu doit être périmé.
    const calls = await mockMba(page, { preview: APERCU });
    await page.goto('/mba/parametres?tab=faq');
    await page.getByTestId('mba-faq-import-open').click();
    await page.getByTestId('mba-import-csv').fill(CSV);
    await page.getByTestId('mba-import-analyse').click();
    await expect(page.getByTestId('mba-import-preview')).toBeVisible();

    const AUTRE = 'question,réponse\nAutre chose ?,Une autre réponse.\n';
    await page.getByTestId('mba-import-csv').fill(AUTRE);
    await expect(page.getByTestId('mba-import-preview')).toHaveCount(0);
    await expect(page.getByTestId('mba-import-confirm')).toBeDisabled();
    expect(appelsMba(calls, 'POST', '/faq/import')).toHaveLength(0);

    // Réanalysé puis confirmé : c'est la SECONDE charge qui part, pas la première qui avait été prévisualisée.
    await page.getByTestId('mba-import-analyse').click();
    await expect(page.getByTestId('mba-import-preview')).toBeVisible();
    await page.getByTestId('mba-import-confirm').click();
    await expect.poll(() => appelsMba(calls, 'POST', '/faq/import')[0]?.body).toEqual({ csv: AUTRE });
    expect(appelsMba(calls, 'POST', '/faq/preview').at(-1)?.body).toEqual({ csv: AUTRE });
  });

  test('🔴 import interrompu (207) : avertissement, reste à faire, et non-duplication annoncée', async ({ page }) => {
    // Une partie EST écrite. Peindre ça en rouge pousserait à tout relancer comme si rien n'était passé.
    await mockMba(page, {
      preview: APERCU,
      importResult: {
        source: 'csv', created: 1, updated: 0, unchanged: 1, remaining: 4,
        ids: { created: ['f9'], updated: [] },
        failed: { question: 'Horaires ?', error: 'Meta: rate limit' },
      },
    });
    await page.goto('/mba/parametres?tab=faq');
    await page.getByTestId('mba-faq-import-open').click();
    await page.getByTestId('mba-import-csv').fill(CSV);
    await page.getByTestId('mba-import-analyse').click();
    await page.getByTestId('mba-import-confirm').click();

    const bandeau = page.getByTestId('mba-import-result');
    await expect(bandeau).toContainText('Horaires ?');
    await expect(bandeau).toContainText('4 question');
    await expect(bandeau).toContainText('ne sera pas dupliqué');
    // Ambre et non rouge : le bandeau d'erreur ne doit PAS être celui utilisé pour un échec.
    await expect(page.getByTestId('mba-import-error')).toHaveCount(0);
  });

  test('source refusée par le serveur : le message remonte, rien n’est écrit', async ({ page }) => {
    const calls = await mockMba(page, {
      custom: async (route, method, url) => {
        if (method === 'POST' && url.includes('/faq/preview')) {
          await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'URL invalide ou non autorisée (http(s) et hôte public attendus)' }) });
          return true;
        }
        return false;
      },
    });
    await page.goto('/mba/parametres?tab=faq');
    await page.getByTestId('mba-faq-import-open').click();
    await page.getByTestId('mba-import-mode-url').click();
    await page.getByTestId('mba-import-url').fill('http://192.168.1.10/faq');
    await page.getByTestId('mba-import-analyse').click();

    await expect(page.getByTestId('mba-import-error')).toContainText('non autorisée');
    await expect(page.getByTestId('mba-import-confirm')).toBeDisabled();
    expect(appelsMba(calls, 'POST', '/faq/import')).toHaveLength(0);
  });
});
