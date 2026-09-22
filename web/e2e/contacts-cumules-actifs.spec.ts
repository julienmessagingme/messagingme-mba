import { test, expect } from '@playwright/test';

/**
 * LA BASCULE CUMULES / ACTIFS DE LA CARTE CONTACTS (demande de Julien du 2026-09-23).
 *
 * 🔴 CE QUE CES SPECS PROTEGENT, ET CE N'EST PAS LE BOUTON. Les deux courbes repondent a DEUX questions :
 * « combien de contacts avons-nous collectes » et « combien nous en reste-t-il ». Sur une base qu'on
 * nettoie, elles divergent, et c'est l'ECART qui est l'information. Une bascule qui afficherait la meme
 * serie dans les deux positions passerait tous les tests d'existence, et ne dirait rien : les assertions
 * portent donc sur le CHIFFRE affiche, jamais sur la presence du bouton.
 *
 * 🔴 ET LE DEFAUT RESTE « CUMULES ». C'est ce que cette carte a toujours montre : basculer le defaut ferait
 * lire une baisse la ou rien n'a bouge, a tous ceux qui regardent cet ecran chaque semaine.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

/**
 * 18 contacts collectes, 15 encore la : l'espace d'essai reel (3 supprimes).
 *
 * ⚠️ LA DATE EST CELLE DU JOUR, PAS UNE DATE FIXE. La carte lit la DERNIERE valeur de la plage affichee, qui
 * est glissante (les 30 derniers jours) : un point date en dur sort de la fenetre des le lendemain, la serie
 * retombe a zero et le test devient rouge sans qu'aucun code n'ait bouge. C'est Europe/Paris, comme partout
 * dans ce produit (`lib/range.ts`).
 */
const AUJ = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
const STATS = {
  contacts: [{ date: AUJ, count: 18 }],
  contactsActifs: [{ date: AUJ, count: 15 }],
  templates: { utility: [], marketing: [] },
  exchanged: [],
  service: [],
  serviceParOrigine: { ia: 0, scenario: 0, humain: 0, indeterminee: 0 },
};

const brancher = async (page: import('@playwright/test').Page, stats: unknown = STATS) => {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/stats(\?|$)/.test(url)) return json(stats);
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
  await page.goto('/dashboard');
};

test.describe('Contacts : cumulés ou actifs', () => {
  test('🔴 par défaut, la carte montre les CUMULÉS', async ({ page }) => {
    await brancher(page);
    await expect(page.getByTestId('contacts-cumules')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('total cumulé')).toBeVisible();
  });

  test('🔴 « Actifs » change le CHIFFRE, pas seulement le libellé', async ({ page }) => {
    await brancher(page);
    // 18 collectés, 15 encore dans le mini-CRM : c'est l'écart qui prouve que la série a changé.
    await expect(page.locator('text=18').first()).toBeVisible();
    await page.getByTestId('contacts-actifs').click();
    await expect(page.getByTestId('contacts-actifs')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('encore dans le mini-CRM')).toBeVisible();
    await expect(page.locator('text=15').first()).toBeVisible();
  });

  test('on revient aux cumulés, et le chiffre revient avec', async ({ page }) => {
    await brancher(page);
    await page.getByTestId('contacts-actifs').click();
    await page.getByTestId('contacts-cumules').click();
    await expect(page.getByText('total cumulé')).toBeVisible();
    await expect(page.locator('text=18').first()).toBeVisible();
  });

  test('🔴 une API qui ne rend PAS les actifs ne montre aucune bascule', async ({ page }) => {
    // Le front part sur Vercel au push, l'API sur le VPS plus tard. Un bouton qui ne montrerait rien est
    // pire que pas de bouton : la carte reste celle d'avant, entière.
    const { contactsActifs, ...sansActifs } = STATS;
    void contactsActifs;
    await brancher(page, sansActifs);
    await expect(page.getByTestId('contacts-bascule')).toHaveCount(0);
    await expect(page.getByText('total cumulé')).toBeVisible();
  });
});
