import { test, expect } from '@playwright/test';

/**
 * E2E création d'un contact à la main.
 *
 * Trois manques signalés par l'exploitant le 2026-08-19 : on ne pouvait poser qu'UN tag, il n'y avait pas de
 * champ e-mail alors que c'est un champ de base, et pas de BSUID pour un client qui n'a pas partagé son numéro.
 * Ce fichier vérifie ce qui PART réellement dans la requête, parce que c'est le seul endroit où l'on voit que
 * les trois arrivent ensemble, et qu'aucun ne devient obligatoire au passage.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

/** Monte /contacts (API bouchonnée) et rend les corps reçus sur la création. */
async function monterContacts(page: import('@playwright/test').Page) {
  const creations: Array<Record<string, unknown>> = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && /\/contacts$/.test(new URL(url).pathname)) {
      creations.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ status: 'created', contactId: 'c-neuf' }) });
    }
    if (url.includes('/contacts/count')) return json({ count: 0 });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/tags')) return json({ tags: ['deja-vu'] });
    if (url.includes('/contacts')) return json({ contacts: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/contacts');
  return { creations };
}

/** Monte /contacts puis ouvre la modale d'ajout à l'unité, en passant par le menu « Rajouter des contacts ». */
async function ouvrirModale(page: import('@playwright/test').Page) {
  const monte = await monterContacts(page);
  await page.getByTestId('contacts-ajouter-menu').click();
  await page.getByTestId('contact-ajouter').click();
  await expect(page.getByTestId('ajout-telephone')).toBeVisible();
  return monte;
}

test.describe('mini-CRM : un seul bouton pour rajouter des contacts', () => {
  test('🔴 le menu mène AUX DEUX façons d’ajouter', async ({ page }) => {
    // Deux boutons côte à côte donnaient deux actions de même poids ; on cherche d'abord « en ajouter », la
    // façon vient ensuite. Ce test tient les deux chemins ensemble : ouvrir le menu en casserait un sinon.
    await monterContacts(page);
    await expect(page.getByTestId('contact-ajouter')).toHaveCount(0);

    await page.getByTestId('contacts-ajouter-menu').click();
    await expect(page.getByTestId('contact-ajouter')).toBeVisible();
    await expect(page.getByTestId('contact-importer-csv')).toBeVisible();

    await page.getByTestId('contact-importer-csv').click();
    await expect(page.getByRole('button', { name: /Retour aux contacts/i })).toBeVisible();
  });
});

test.describe('mini-CRM : ajouter un contact à la main', () => {
  test('🔴 plusieurs tags, e-mail et BSUID partent ensemble', async ({ page }) => {
    const { creations } = await ouvrirModale(page);
    await page.getByTestId('ajout-telephone').fill('06 12 34 56 78');
    await page.getByTestId('ajout-prenom').fill('Albert');
    await page.getByTestId('ajout-nom').fill('Dupontel');
    await page.getByTestId('ajout-email').fill('albert@exemple.fr');
    await page.getByTestId('ajout-bsuid').fill('wa-abc123');

    // Deux tags : le premier validé par Entrée, le second par le bouton.
    await page.getByTestId('ajout-tag').fill('salon-2026');
    await page.getByTestId('ajout-tag').press('Enter');
    await page.getByTestId('ajout-tag').fill('vip');
    await page.getByTestId('ajout-tag-valider').click();
    await expect(page.getByTestId('ajout-tags-retenus')).toContainText('salon-2026');
    await expect(page.getByTestId('ajout-tags-retenus')).toContainText('vip');

    await page.getByTestId('ajout-valider').click();

    await expect.poll(() => creations.length).toBe(1);
    expect(creations[0]).toMatchObject({
      phone: '06 12 34 56 78',
      name: 'Dupontel',
      fields: { prenom: 'Albert', email: 'albert@exemple.fr' },
      tags: ['salon-2026', 'vip'],
      bsuid: 'wa-abc123',
      optIn: true,
    });
  });

  test('🔴 Entrée dans le champ tag AJOUTE le tag, elle ne valide pas la fiche', async ({ page }) => {
    // Sans ce garde-fou, saisir un 2e tag envoyait le formulaire avec le premier seulement.
    const { creations } = await ouvrirModale(page);
    await page.getByTestId('ajout-telephone').fill('0612345678');
    await page.getByTestId('ajout-tag').fill('premier');
    await page.getByTestId('ajout-tag').press('Enter');
    expect(creations).toEqual([]); // la fiche n'est PAS partie
    await expect(page.getByTestId('ajout-tags-retenus')).toContainText('premier');
  });

  test('🔴 un tag tapé sans être validé compte quand même', async ({ page }) => {
    // Le perdre en silence est le pire des deux mondes : l'opérateur l'a bien saisi.
    const { creations } = await ouvrirModale(page);
    await page.getByTestId('ajout-telephone').fill('0612345678');
    await page.getByTestId('ajout-tag').fill('oublie');
    await page.getByTestId('ajout-valider').click();
    await expect.poll(() => creations.length).toBe(1);
    expect(creations[0]).toMatchObject({ tags: ['oublie'] });
  });

  test('un tag retenu se retire', async ({ page }) => {
    await ouvrirModale(page);
    await page.getByTestId('ajout-tag').fill('a-retirer');
    await page.getByTestId('ajout-tag-valider').click();
    const retenus = page.getByTestId('ajout-tags-retenus');
    await expect(retenus).toContainText('a-retirer');
    await retenus.getByRole('button').first().click();
    await expect(retenus).toHaveCount(0);
  });

  test('🔴 le numéro suffit : les trois nouveaux champs restent optionnels', async ({ page }) => {
    const { creations } = await ouvrirModale(page);
    await page.getByTestId('ajout-telephone').fill('0612345678');
    await page.getByTestId('ajout-valider').click();
    await expect.poll(() => creations.length).toBe(1);
    expect(creations[0]).toEqual({ phone: '0612345678', optIn: true });
  });
});
