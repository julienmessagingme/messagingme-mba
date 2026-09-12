import { test, expect } from '@playwright/test';
import { TREIZE_POUCES, pasDeDebordement } from './aide/largeur';

/**
 * La joignabilité WhatsApp sur la fiche contact, et son filtre d'audience (migration 0133).
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT : que l'écran n'écrive JAMAIS « injoignable » sur un contact qu'on n'a pas
 * mesuré. C'est le même défaut que confondre `null` et `false` en base, transposé à l'affichage, et il est
 * pire ici parce que l'opérateur agit sur ce qu'il lit : un contact marqué injoignable à tort ne sera jamais
 * recontacté par personne, et rien à l'écran ne dira que c'était une supposition.
 *
 * ⚠️ Le cas PÉRIMÉ est le plus facile à perdre : la colonne dit encore `false`, et seul le passage par
 * `verdictWhatsApp` le fait redevenir « Jamais testé ». Un `contact.whatsappJoignable === false` écrit dans
 * le JSX passerait les deux autres cas et raterait celui-là.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const jours = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

const BASE = { bsuid: null, optInStatus: 'opted_in', tags: [], fields: {}, createdAt: '2026-01-01T00:00:00Z' };
/** Jamais sollicité : les deux colonnes à null. C'est l'état de tout le parc au déploiement de 0133. */
const JAMAIS = { ...BASE, id: 'ct1', profileName: 'Anna Jamais', phoneE164: '+33600000001', whatsappJoignable: null, whatsappJoignableLe: null };
/** Mesuré injoignable il y a 10 jours : la mesure vaut encore. */
const INJOIGNABLE = { ...BASE, id: 'ct2', profileName: 'Bruno Injoignable', phoneE164: '+33600000002', whatsappJoignable: false, whatsappJoignableLe: jours(10) };
/** Mesuré injoignable il y a 120 jours : PÉRIMÉ, donc redevenu inconnu. */
const PERIME = { ...BASE, id: 'ct3', profileName: 'Chloe Perimee', phoneE164: '+33600000003', whatsappJoignable: false, whatsappJoignableLe: jours(120) };
/** Mesuré joignable il y a 2 jours. */
const JOIGNABLE = { ...BASE, id: 'ct4', profileName: 'Diane Joignable', phoneE164: '+33600000004', whatsappJoignable: true, whatsappJoignableLe: jours(2) };

const CONTACTS = [JAMAIS, INJOIGNABLE, PERIME, JOIGNABLE];

async function mock(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = route.request().url().split('?')[0]!;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/conversations/todo-count')) return json({ count: 0 });
    if (chemin.endsWith('/contacts')) return json({ contacts: CONTACTS, total: CONTACTS.length });
    if (chemin.endsWith('/user-fields')) return json({ fields: [] });
    if (chemin.endsWith('/tags')) return json({ tags: [] });
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

/** Ouvre la fiche d'un contact depuis la liste et rend le bloc de joignabilité. */
async function ficheDe(page: import('@playwright/test').Page, nom: string) {
  await page.getByText(nom).first().click();
  return page.getByTestId('fiche-joignabilite');
}

test.describe('Fiche contact : joignabilité WhatsApp', () => {
  test.use({ viewport: TREIZE_POUCES });

  test('🔴 un contact jamais sollicité affiche « Jamais testé », jamais « injoignable »', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');
    const bloc = await ficheDe(page, 'Anna Jamais');
    await expect(bloc).toContainText('Jamais testé');
    await expect(bloc).not.toContainText('injoignable');
    // Pas de date non plus : il n'y a rien à dater, et une date vide se lirait comme une mesure manquée.
    await expect(bloc).not.toContainText('mesuré le');
  });

  test('un contact mesuré injoignable le dit, AVEC la date de la mesure', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');
    const bloc = await ficheDe(page, 'Bruno Injoignable');
    await expect(bloc).toContainText('injoignable');
    // La date rend le verdict jugeable : « injoignable » d'hier et d'il y a trois mois ne se valent pas.
    await expect(bloc).toContainText('mesuré le');
  });

  test('🔴 une mesure PÉRIMÉE redevient « Jamais testé » : on n\'exclut personne à vie', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');
    const bloc = await ficheDe(page, 'Chloe Perimee');
    // La colonne dit encore `false`. Seul le passage par la règle partagée la fait redevenir inconnue.
    await expect(bloc).toContainText('Jamais testé');
    await expect(bloc).not.toContainText('injoignable');
  });

  test('un contact mesuré joignable le dit', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');
    const bloc = await ficheDe(page, 'Diane Joignable');
    await expect(bloc).toContainText('joignable');
    await expect(bloc).not.toContainText('injoignable');
  });

  test('le filtre d\'audience n\'offre QUE « sauf les injoignables connus »', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');
    // ⚠️ Le panneau de filtres est REPLIÉ par défaut : sans ce clic, le test ne mesurerait rien et un
    // sélecteur absent se lirait comme un sélecteur vide.
    await page.getByTestId('contacts-toggle-filters').click();
    const filtre = page.getByTestId('filtre-joignabilite');
    await expect(filtre).toBeVisible();
    // ⚠️ Pas de « seulement les joignables » : ce serait exclure tout le parc jamais sollicité, c'est-à-dire
    // l'inverse de ce qu'un opérateur croit demander.
    await expect(filtre.locator('option')).toHaveCount(2);
    await filtre.selectOption('connu_injoignable');
    await expect(filtre).toHaveValue('connu_injoignable');
  });

  test('sur un 13 pouces, ni le filtre ni la fiche ne débordent', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');

    // État 1 : panneau de filtres DÉPLIÉ. C'est lui qui gagne une colonne de plus dans une grille à 3.
    await page.getByTestId('contacts-toggle-filters').click();
    await expect(page.getByTestId('filtre-joignabilite')).toBeVisible();
    await pasDeDebordement(page);

    // État 2 : la fiche, par-dessus.
    //
    // ⚠️ PAS DE `pasDeChevauchement` ENTRE LA FICHE ET LE FILTRE, et ce n'est pas une facilité : la fiche est
    // une MODALE (`fixed inset-0 z-50`), donc elle recouvre TOUT par construction. Le helper comparerait deux
    // couches différentes et échouerait sur le fonctionnement normal de l'écran. Mesuré : il échoue bien,
    // avec « fiche-champs-base chevauche filtre-joignabilite ».
    await ficheDe(page, 'Bruno Injoignable');
    await pasDeDebordement(page);

    // Ce qui est vrai ET utile ici : la ligne de joignabilité reste DANS la grille des champs de base. C'est
    // le vrai risque de cet ajout, un badge et une date sur la même ligne d'une grille `[110px_1fr]`.
    const grille = (await page.getByTestId('fiche-champs-base').boundingBox())!;
    const ligne = (await page.getByTestId('fiche-joignabilite').boundingBox())!;
    expect(ligne.x + ligne.width, 'la ligne de joignabilité sort de la grille des champs de base')
      .toBeLessThanOrEqual(grille.x + grille.width + 1);
  });
});
