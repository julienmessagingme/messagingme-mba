import { test, expect } from '@playwright/test';

/**
 * Contenu > Modèles d'email : un admin crée un modèle basique (nom, sujet, corps), le voit listé, insère une
 * variable de champ dans le sujet via les chips, et bascule le format en HTML (zone de corps en HTML brut).
 * Backend intercepté, aucune base (même pattern que nodes-blocs.spec.ts).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

async function mockPage(page: import('@playwright/test').Page, templates: Array<Record<string, unknown>>) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  const created: Array<Record<string, unknown>> = [];
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });

    if (req.method() === 'POST' && /\/email\/templates$/.test(path)) {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const tpl = { id: `tpl${created.length + 1}`, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', ...body };
      created.push(tpl);
      templates.push(tpl);
      return json(tpl);
    }
    if (path.includes('/email/templates')) return json({ templates });
    if (path.includes('/user-fields')) {
      return json({ fields: [
        { key: 'prenom', label: 'Prénom', type: 'text' },
        { key: 'email', label: 'Email', type: 'text' },
        { key: 'name', label: 'Nom', type: 'text' }, // système/attribut : NE DOIT PAS apparaître comme variable
      ] });
    }
    if (path.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  return { created };
}

test.describe('Contenu : modèles d’email', () => {
  test('un admin crée un modèle basique, avec une variable insérée au sujet', async ({ page }) => {
    const templates: Array<Record<string, unknown>> = [];
    const { created } = await mockPage(page, templates);

    await page.goto('/email-templates');
    await page.getByRole('button', { name: /Nouveau modèle/i }).click();

    await page.getByTestId('email-template-name').fill('Confirmation');
    await page.getByTestId('email-template-subject').fill('Bonjour');
    // Insère {{prenom}} au curseur du sujet (dernier champ actif après le .fill ci-dessus).
    await page.getByTestId('email-template-var-prenom').click();
    await page.getByTestId('email-template-body').fill('Merci de votre message.');
    await page.getByTestId('email-template-save').click();

    await expect.poll(() => created.length).toBe(1);
    expect(created[0]).toMatchObject({ name: 'Confirmation', format: 'basic', subject: 'Bonjour{{prenom}}', body: 'Merci de votre message.' });
    await expect(page.getByText('Confirmation')).toBeVisible();
  });

  test('le champ système « Nom » (attribut, non résoluble en email) n’apparaît pas comme variable', async ({ page }) => {
    const templates: Array<Record<string, unknown>> = [];
    await mockPage(page, templates);

    await page.goto('/email-templates');
    await page.getByRole('button', { name: /Nouveau modèle/i }).click();

    await expect(page.getByTestId('email-template-var-prenom')).toBeVisible();
    await expect(page.getByTestId('email-template-var-email')).toBeVisible();
    await expect(page.getByTestId('email-template-var-name')).toHaveCount(0);
  });

  test('bascule HTML : le corps devient une zone de HTML brut (police mono)', async ({ page }) => {
    const templates: Array<Record<string, unknown>> = [];
    await mockPage(page, templates);

    await page.goto('/email-templates');
    await page.getByRole('button', { name: /Nouveau modèle/i }).click();
    await page.getByTestId('email-template-format-html').click();

    await expect(page.getByTestId('email-template-body')).toHaveClass(/font-mono/);
  });

  test('modifier un modèle existant pré-remplit le formulaire', async ({ page }) => {
    const templates: Array<Record<string, unknown>> = [
      { id: 'tpl1', name: 'Bienvenue', format: 'html', subject: 'Bonjour {{prenom}}', body: '<p>Salut</p>', createdAt: '', updatedAt: '' },
    ];
    await mockPage(page, templates);

    await page.goto('/email-templates');
    await page.getByText('Bienvenue').waitFor();
    await page.getByRole('button', { name: 'Modifier' }).click();

    await expect(page.getByTestId('email-template-name')).toHaveValue('Bienvenue');
    await expect(page.getByTestId('email-template-subject')).toHaveValue('Bonjour {{prenom}}');
    await expect(page.getByTestId('email-template-body')).toHaveValue('<p>Salut</p>');
  });
});
