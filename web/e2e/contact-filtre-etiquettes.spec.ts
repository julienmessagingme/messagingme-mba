import { test, expect } from './aide/test';
import { TREIZE_POUCES, pasDeDebordement } from './aide/largeur';

/**
 * Les filtres d'étiquettes des contacts se valident à la SOURIS. Ce sont les seuls filtres du panneau qui
 * ne s'appliquent pas en tapant : une étiquette n'entre dans le filtre qu'une fois validée, et seule la
 * touche Entrée le faisait. Une étiquette choisie dans la liste de suggestions restait donc dans la case,
 * sans effet, et rien à l'écran ne disait quoi faire (retour de Julien, 2026-10-28).
 *
 * ⚠️ Ces tests ne touchent JAMAIS le clavier pour valider : un `press('Enter')` les rendrait verts sans bouton.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONTACT = {
  id: 'ct1', profileName: 'Anna Vip', phoneE164: '+33600000001', bsuid: null, optInStatus: 'opted_in',
  tags: ['vip'], fields: {}, createdAt: '2026-01-01T00:00:00Z',
};

/** Rend les paramètres de chaque GET `/contacts`, pour lire ce que le filtre a réellement envoyé. */
async function mock(page: import('@playwright/test').Page): Promise<URLSearchParams[]> {
  const requetes: URLSearchParams[] = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.pathname.endsWith('/conversations/todo-count')) return json({ count: 0 });
    if (url.pathname.endsWith('/contacts')) { requetes.push(url.searchParams); return json({ contacts: [CONTACT], total: 1 }); }
    if (url.pathname.endsWith('/user-fields')) return json({ fields: [] });
    if (url.pathname.endsWith('/tags')) return json({ tags: [{ tag: 'vip', count: 1 }, { tag: 'salon', count: 3 }] });
    if (url.pathname.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  return requetes;
}

test.describe('Contacts : les filtres d\'étiquettes se valident par un bouton', () => {
  test.use({ viewport: TREIZE_POUCES });

  test('🔴 « Possède les étiquettes » : le bouton ajoute l\'étiquette et la liste se filtre', async ({ page }) => {
    const requetes = await mock(page);
    await page.goto('/contacts');
    await page.getByTestId('contacts-toggle-filters').click();

    const bouton = page.getByTestId('filtre-ajouter-etiquette');
    // Case vide : rien à valider, le bouton le dit au lieu d'envoyer un filtre vide.
    await expect(bouton).toBeDisabled();

    await page.getByPlaceholder('Étiquette…').first().fill('vip');
    await bouton.click();

    // L'étiquette devient une pastille retirable, et la case se vide pour la suivante.
    await expect(page.locator('span', { hasText: 'vip', has: page.getByRole('button', { name: 'Retirer' }) })).toBeVisible();
    await expect(page.getByPlaceholder('Étiquette…').first()).toHaveValue('');
    await expect(bouton).toBeDisabled();
    // Et le filtre est PARTI : sans ça, une pastille dessinée sur un filtre jamais appliqué passerait le test.
    await expect.poll(() => requetes.some((q) => q.get('tags') === 'vip')).toBe(true);
  });

  test('🔴 « Ne possède pas les étiquettes » : le bouton exclut l\'étiquette', async ({ page }) => {
    const requetes = await mock(page);
    await page.goto('/contacts');
    await page.getByTestId('contacts-toggle-filters').click();

    await page.getByPlaceholder('Étiquette…').nth(1).fill('salon');
    await page.getByTestId('filtre-exclure-etiquette').click();

    await expect.poll(() => requetes.some((q) => q.get('tagsExclude') === 'salon')).toBe(true);
    // L'exclusion ne se confond pas avec l'inclusion.
    expect(requetes.some((q) => q.get('tags') === 'salon')).toBe(false);
  });

  test('sur un 13 pouces, les deux boutons ne font pas déborder le panneau', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');
    await page.getByTestId('contacts-toggle-filters').click();
    await expect(page.getByTestId('filtre-exclure-etiquette')).toBeVisible();
    await pasDeDebordement(page);
  });
});
