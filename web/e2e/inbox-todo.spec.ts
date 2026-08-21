import { test, expect } from '@playwright/test';

/**
 * E2E inbox : le filtre « À traiter » ne montre que les conversations que le scénario ne gère plus
 * (control_owner != app_workflow : opérateur, node inbox escaladé, ou MBA).
 *
 * ⚠️ Le filtrage est fait par le SERVEUR depuis la pagination. Auparavant l'écran filtrait en mémoire les
 * conversations chargées : au-delà d'une page il ignorait le reste sans rien signaler, et le compteur
 * affichait moins que la réalité. Ces tests vérifient donc que l'écran DEMANDE le bon filtre, et non plus
 * qu'il trie lui-même : c'est le fond du changement.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const CONVERSATIONS = [
  { id: 'c1', waId: '33600000001', profileName: 'Alice Auto', lastPreview: 'gérée par le scénario', lastMessageAt: '2026-08-02T10:00:00Z', controlOwner: 'app_workflow' },
  { id: 'c2', waId: '33600000002', profileName: 'Bob ATraiter', lastPreview: 'un humain doit répondre', lastMessageAt: '2026-08-02T11:00:00Z', controlOwner: 'app_human' },
];

/** Faux backend qui APPLIQUE le filtre demandé, comme le vrai : sinon on ne testerait que l'affichage. */
async function mock(page: import('@playwright/test').Page, totalATraiter?: number) {
  const urls: string[] = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    urls.push(url);
    const chemin = url.split('?')[0]!;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/conversations/todo-count')) {
      return json({ count: totalATraiter ?? CONVERSATIONS.filter((c) => c.controlOwner !== 'app_workflow').length });
    }
    if (chemin.endsWith('/conversations')) {
      const aTraiter = new URL(url).searchParams.get('aTraiter') === '1';
      return json({ conversations: aTraiter ? CONVERSATIONS.filter((c) => c.controlOwner !== 'app_workflow') : CONVERSATIONS });
    }
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  return urls;
}

test.describe('Inbox : filtre « À traiter »', () => {
  test('« À traiter » ne garde que les conversations hors app_workflow', async ({ page }) => {
    await mock(page);
    await page.goto('/inbox');

    // Par défaut : les deux conversations sont visibles.
    await expect(page.getByText('Alice Auto')).toBeVisible();
    await expect(page.getByText('Bob ATraiter')).toBeVisible();

    // Filtre « À traiter » -> seule Bob (app_human) reste ; Alice (app_workflow) disparaît.
    await page.getByTestId('inbox-filter-todo').click();
    await expect(page.getByText('Bob ATraiter')).toBeVisible();
    await expect(page.getByText('Alice Auto')).toHaveCount(0);
  });

  test('🔴 le filtre est DEMANDÉ au serveur, pas appliqué en mémoire', async ({ page }) => {
    // C'est la garantie qui compte : un filtrage local ne verrait que la page chargée et ignorerait le reste
    // en silence. Si quelqu'un revient à un `filter()` côté navigateur, ce test tombe.
    const urls = await mock(page);
    await page.goto('/inbox');
    await expect(page.getByText('Alice Auto')).toBeVisible();
    await page.getByTestId('inbox-filter-todo').click();
    await expect.poll(() => urls.some((u) => u.includes('aTraiter=1')), { timeout: 15_000 }).toBe(true);
  });

  test('🔴 le compteur vient du SERVEUR : il compte au-delà des conversations affichées', async ({ page }) => {
    // Le défaut corrigé : l'écran comptait sur la liste chargée, donc il plafonnait à la taille de la page.
    // Ici le serveur en annonce 137 alors que deux conversations seulement sont affichées.
    await mock(page, 137);
    await page.goto('/inbox');
    await expect(page.getByTestId('inbox-filter-todo')).toContainText('137');
  });
});
