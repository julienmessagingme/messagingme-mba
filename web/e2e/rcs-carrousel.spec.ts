import { test, expect, type Page } from '@playwright/test';
import { TREIZE_POUCES, pasDeDebordement } from './aide/largeur';

/**
 * Contenu > Messages RCS : le CARROUSEL, et le dessin repris de Contenu > Templates (2026-09-21).
 *
 * Ce qu'on protège, comme dans `rcs-messages.spec.ts` : le corps RÉELLEMENT posté. Un écran peut montrer dix
 * cartes et n'en poster que deux, ou poser le visuel d'une carte sur sa voisine.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const IMG = 'https://exemple.test/v.jpg';

const CARROUSEL = {
  id: 'c1', name: 'Sélection rentrée', createdAt: '', updatedAt: '',
  content: {
    kind: 'carousel',
    cards: [
      { title: 'Séjour à Nice', description: 'Dès 99 €', mediaUrl: IMG, mediaHeight: 'TALL', suggestions: [{ kind: 'reply', text: 'Je veux', postbackData: 'carte1_btn1' }] },
      { title: 'Séjour à Lyon', description: 'Dès 79 €', mediaUrl: IMG, mediaHeight: 'TALL' },
    ],
  },
};
const SIMPLE = { id: 's1', name: 'Relance', createdAt: '', updatedAt: '', content: { kind: 'text', text: 'Bonjour {{prenom}}' } };

interface Envois {
  posts: Array<Record<string, unknown>>;
  patches: Array<{ url: string; body: Record<string, unknown> }>;
}

async function mock(page: Page, messages: unknown[] = []): Promise<Envois> {
  const envois: Envois = { posts: [], patches: [] };
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && url.includes('/rcs-messages')) {
      envois.posts.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
      return json({ message: { id: 'n1', name: 'x', content: null, createdAt: '', updatedAt: '' } }, 201);
    }
    if (req.method() === 'PATCH' && url.includes('/rcs-messages/')) {
      envois.patches.push({ url, body: (req.postDataJSON() ?? {}) as Record<string, unknown> });
      return json({ ok: true });
    }
    if (url.includes('/rcs-messages')) return json({ messages });
    if (url.includes('/rcs-agents')) return json({ agents: [{ agentId: 'ag1', brandName: 'Ma marque', status: 'launched' }] });
    if (url.includes('/user-fields')) return json({ fields: [{ key: 'prenom', label: 'Prénom', type: 'text' }] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  return envois;
}

async function nouveauCarrousel(page: Page): Promise<void> {
  await page.goto('/rcs-messages');
  await page.getByTestId('rcs-message-new').click();
  await page.getByTestId('rcs-format-carrousel').click();
  await expect(page.getByTestId('rcs-carrousel-nom')).toBeVisible({ timeout: 15_000 });
}

test.describe('Contenu : carrousel RCS', () => {
  test('🔴 compose un carrousel de deux cartes et poste EXACTEMENT ses cartes', async ({ page }) => {
    const envois = await mock(page);
    await nouveauCarrousel(page);
    await page.getByTestId('rcs-carrousel-nom').fill('Sélection rentrée');

    await page.getByTestId('rcs-carte-0-image').fill(IMG);
    await page.getByTestId('rcs-carte-0-titre').fill('Séjour à Nice');
    await page.getByTestId('rcs-carte-0-texte').fill('Dès 99 €');
    await page.getByTestId('rcs-carte-0-message-add-button').click();
    await page.getByTestId('rcs-carte-0').getByPlaceholder('Libellé du bouton').fill('Je veux');

    await page.getByTestId('rcs-carte-1-image').fill(IMG);
    await page.getByTestId('rcs-carte-1-texte').fill('Séjour à Lyon');

    // L'aperçu montre les deux cartes, titre et bouton compris, AVANT tout enregistrement.
    await expect(page.getByTestId('rcs-carrousel-apercu-carte-0')).toContainText('Séjour à Nice');
    await expect(page.getByTestId('rcs-carrousel-apercu-carte-0')).toContainText('Je veux');
    await expect(page.getByTestId('rcs-carrousel-apercu-carte-1')).toContainText('Séjour à Lyon');

    await page.getByTestId('rcs-carrousel-enregistrer').click();
    await expect.poll(() => envois.posts.length, { timeout: 10_000 }).toBe(1);
    expect(envois.posts[0]).toEqual({
      name: 'Sélection rentrée',
      content: {
        kind: 'carousel',
        cards: [
          {
            title: 'Séjour à Nice', description: 'Dès 99 €', mediaUrl: IMG, mediaHeight: 'TALL',
            suggestions: [{ kind: 'reply', text: 'Je veux', postbackData: 'carte1_btn1' }],
          },
          { description: 'Séjour à Lyon', mediaUrl: IMG, mediaHeight: 'TALL' },
        ],
      },
    });
  });

  test('dit ce qui manque, carte par carte, et ne poste rien tant qu il manque', async ({ page }) => {
    const envois = await mock(page);
    await nouveauCarrousel(page);
    const manques = page.getByTestId('rcs-carrousel-manques');
    await expect(manques).toContainText('le nom du carrousel');
    await expect(manques).toContainText('le visuel ou le titre de la carte 1');
    await expect(manques).toContainText('le visuel ou le titre de la carte 2');
    await expect(page.getByTestId('rcs-carrousel-enregistrer')).toBeDisabled();

    await page.getByTestId('rcs-carrousel-nom').fill('X');
    await page.getByTestId('rcs-carte-0-titre').fill('Titre seul');
    await expect(manques).not.toContainText('carte 1');
    await expect(manques).toContainText('le visuel ou le titre de la carte 2');
    expect(envois.posts).toHaveLength(0);
  });

  test('deux cartes au minimum, dix au plus', async ({ page }) => {
    await mock(page);
    await nouveauCarrousel(page);
    await expect(page.getByTestId('rcs-carte-0-retirer')).toBeDisabled();
    const ajouter = page.getByTestId('rcs-carrousel-ajouter-carte');
    for (let i = 0; i < 8; i += 1) await ajouter.click();
    await expect(page.getByTestId('rcs-carte-9')).toBeVisible();
    await expect(ajouter).toBeDisabled();
    await page.getByTestId('rcs-carte-9-retirer').click();
    await expect(page.getByTestId('rcs-carte-9')).toHaveCount(0);
    await expect(ajouter).toBeEnabled();
  });

  test('🔴 basculer de format ne perd pas la saisie', async ({ page }) => {
    await mock(page);
    await page.goto('/rcs-messages');
    await page.getByTestId('rcs-message-new').click();
    await page.getByTestId('rcs-message-name').fill('Mon message');
    await page.getByTestId('rcs-message-text').fill('Bonjour');
    await page.getByTestId('rcs-format-carrousel').click();
    await page.getByTestId('rcs-carrousel-nom').fill('Mon carrousel');
    await page.getByTestId('rcs-format-simple').click();
    await expect(page.getByTestId('rcs-message-name')).toHaveValue('Mon message');
    await expect(page.getByTestId('rcs-message-text')).toHaveText('Bonjour');
    await page.getByTestId('rcs-format-carrousel').click();
    await expect(page.getByTestId('rcs-carrousel-nom')).toHaveValue('Mon carrousel');
  });

  test('le tableau dit le format, et un carrousel se modifie dans SON formulaire', async ({ page }) => {
    const envois = await mock(page, [CARROUSEL, SIMPLE]);
    await page.goto('/rcs-messages');
    await expect(page.getByTestId('rcs-message-format-c1')).toHaveText('carrousel · 2 cartes');
    await expect(page.getByTestId('rcs-message-format-s1')).toHaveText('message');
    await page.getByTestId('rcs-message-editer-c1').click();
    // Pas de sélecteur de format en modification, comme pour un template.
    await expect(page.getByTestId('rcs-format-simple')).toHaveCount(0);
    await expect(page.getByTestId('rcs-carte-1-titre')).toHaveValue('Séjour à Lyon');
    await page.getByTestId('rcs-carte-1-titre').fill('Séjour à Lille');
    await page.getByTestId('rcs-carrousel-enregistrer').click();
    await expect.poll(() => envois.patches.length, { timeout: 10_000 }).toBe(1);
    expect(envois.patches[0]!.url).toContain('/rcs-messages/c1');
    expect(envois.patches[0]!.body).toMatchObject({
      name: 'Sélection rentrée',
      content: { kind: 'carousel', cards: [{ title: 'Séjour à Nice' }, { title: 'Séjour à Lille' }] },
    });
  });

  test('le nom ouvre l aperçu, dans le cadre de telephone de la marque', async ({ page }) => {
    await mock(page, [CARROUSEL]);
    await page.goto('/rcs-messages');
    await page.getByRole('button', { name: 'Sélection rentrée' }).click();
    const fenetre = page.getByTestId('rcs-message-apercu');
    await expect(fenetre.getByTestId('rcs-carrousel-apercu-carte-0')).toContainText('Séjour à Nice');
    await expect(fenetre.getByTestId('apercu-rcs-marque')).toHaveText('Ma marque');
  });

  test('🔴 a 1280 px, le formulaire carrousel ne deborde pas', async ({ page }) => {
    await page.setViewportSize(TREIZE_POUCES);
    await mock(page);
    await nouveauCarrousel(page);
    await page.getByTestId('rcs-carte-0-message-add-button').click();
    await pasDeDebordement(page);
  });
});
