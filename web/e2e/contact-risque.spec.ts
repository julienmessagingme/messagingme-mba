import { test, expect } from '@playwright/test';
import { TREIZE_POUCES, pasDeDebordement } from './aide/largeur';

/**
 * Le risque de désengagement sur la fiche contact, et son filtre dans la liste (lot 7 de l'API publique).
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT : que l'écran n'invente JAMAIS un niveau. Une fiche jamais calculée, ou venue
 * d'une API qui ne rend pas encore le champ (la console part après l'API, mais un retour arrière de l'API reste
 * possible), dit « pas encore calculé ». Un contact « inconnu » n'a pas de score. Et le filtre part tel quel au
 * serveur, dans la même requête que les autres filtres.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const CALCULE = '2026-09-25T03:05:00.000Z';

const BASE = { bsuid: null, optInStatus: 'opted_in', tags: [], fields: {}, createdAt: '2026-01-01T00:00:00Z', whatsappJoignable: null, whatsappJoignableLe: null };
const ELEVE = {
  ...BASE, id: 'ct1', profileName: 'Anna Eleve', phoneE164: '+33600000001',
  risque: { niveau: 'eleve', score: 75, raisons: ['silence_60j', 'reclamation', 'sans_reponse'], calculeLe: CALCULE },
};
const INCONNU = { ...BASE, id: 'ct2', profileName: 'Bruno Inconnu', phoneE164: '+33600000002', risque: { niveau: 'inconnu', score: null, raisons: [], calculeLe: CALCULE } };
const JAMAIS = { ...BASE, id: 'ct3', profileName: 'Chloe Jamais', phoneE164: '+33600000003', risque: null };
/** Une API d'avant le lot 7 : le champ n'existe pas du tout. */
const SANS_CHAMP = { ...BASE, id: 'ct4', profileName: 'Diane Ancienne', phoneE164: '+33600000004' };

const CONTACTS = [ELEVE, INCONNU, JAMAIS, SANS_CHAMP];

async function mock(page: import('@playwright/test').Page, requetes: string[] = []): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const chemin = url.split('?')[0]!;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/conversations/todo-count')) return json({ count: 0 });
    if (chemin.endsWith('/contacts')) {
      requetes.push(url);
      return json({ contacts: CONTACTS, total: CONTACTS.length });
    }
    if (chemin.endsWith('/user-fields')) return json({ fields: [] });
    if (chemin.endsWith('/tags')) return json({ tags: [] });
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

async function ficheDe(page: import('@playwright/test').Page, nom: string) {
  await page.getByText(nom).first().click();
  return page.getByTestId('fiche-risque');
}

test.describe('Fiche contact : risque de désengagement', () => {
  test.use({ viewport: TREIZE_POUCES });

  test('🔴 un risque élevé montre le niveau, le score, les raisons EN FRANÇAIS et la date du calcul', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');
    const bloc = await ficheDe(page, 'Anna Eleve');
    await expect(bloc.getByTestId('fiche-risque-niveau')).toHaveText('élevé');
    await expect(bloc.getByTestId('fiche-risque-score')).toHaveText('75 / 100');
    await expect(bloc).toContainText('calculé le');
    const raisons = bloc.getByTestId('fiche-risque-raisons').locator('li');
    await expect(raisons).toHaveCount(3);
    await expect(raisons.nth(0)).toHaveText('Aucune réponse, aucun clic ni aucune lecture depuis plus de 60 jours');
    await expect(raisons.nth(1)).toHaveText('Dernière conversation : une réclamation non résolue');
    // Les codes eux-mêmes ne s'affichent jamais quand la console les connaît.
    await expect(bloc).not.toContainText('silence_60j');
  });

  test('🔴 « inconnu » n’a pas de score, et dit pourquoi', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');
    const bloc = await ficheDe(page, 'Bruno Inconnu');
    await expect(bloc.getByTestId('fiche-risque-niveau')).toHaveText('inconnu');
    await expect(bloc.getByTestId('fiche-risque-score')).toHaveCount(0);
    await expect(bloc).toContainText('Aucun message ne lui a été délivré sur les 90 derniers jours');
  });

  test('🔴 jamais calculé : « pas encore calculé », aucun niveau', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');
    const bloc = await ficheDe(page, 'Chloe Jamais');
    await expect(bloc.getByTestId('fiche-risque-absent')).toHaveText('pas encore calculé');
    await expect(bloc.getByTestId('fiche-risque-niveau')).toHaveCount(0);
  });

  test('🔴 une API qui ne rend PAS ENCORE le champ : la fiche s’ouvre et dit « pas encore calculé »', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');
    const bloc = await ficheDe(page, 'Diane Ancienne');
    await expect(bloc.getByTestId('fiche-risque-absent')).toBeVisible();
    // La fiche entière est là, pas seulement la ligne : un champ absent ne doit rien démonter.
    await expect(page.getByTestId('fiche-joignabilite')).toBeVisible();
  });

  test('le filtre propose les quatre niveaux, et le choix part au serveur dans la requête de la liste', async ({ page }) => {
    const requetes: string[] = [];
    await mock(page, requetes);
    await page.goto('/contacts');
    // ⚠️ Le panneau est REPLIÉ par défaut : sans ce clic, un sélecteur absent se lirait comme un sélecteur vide.
    await page.getByTestId('contacts-toggle-filters').click();
    const filtre = page.getByTestId('filtre-risque');
    await expect(filtre.locator('option')).toHaveCount(5);
    await filtre.selectOption('eleve');
    await expect.poll(() => requetes.some((u) => new URL(u).searchParams.get('risque') === 'eleve')).toBe(true);
  });

  test('sur un 13 pouces, trois raisons ne font déborder ni la fiche ni la grille', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');
    await ficheDe(page, 'Anna Eleve');
    await pasDeDebordement(page);
    const grille = (await page.getByTestId('fiche-champs-base').boundingBox())!;
    const ligne = (await page.getByTestId('fiche-risque').boundingBox())!;
    expect(ligne.x + ligne.width, 'la ligne du risque sort de la grille des champs de base').toBeLessThanOrEqual(grille.x + grille.width + 1);
  });
});
