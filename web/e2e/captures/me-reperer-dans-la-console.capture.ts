import { test, expect } from '../aide/test';
import { mockAccueil } from '../support/accueil';
import { NAVIGATEUR, REGLAGES_ACCUEIL, REGLAGES_DEMO, STATS_DEMO, capturer, chiffresAccueil, communs, langue, type Locale } from './donnees-demo';

/**
 * « Me repérer dans la console » : l'onglet Console (l'Accueil d'un espace connecté), l'onglet Inbox, le Performance
 * Lab, le menu Compte ouvert, puis Paramètres > Général et ses heures d'ouverture.
 */
const CLE = 'me-reperer-dans-la-console';
const COMPTE = { number: '+33 6 39 98 01 00', verifiedName: 'Votre marque', ownerBusinessName: 'Votre marque', phoneNumberId: 'pn-demo' };
const CONVERSATIONS = [
  { id: 'c1', waId: '33639980101', profileName: 'Léa Martin', lastPreview: 'La veste camel existe en 38 ?', lastMessageAt: '2026-10-21T08:42:00Z', controlOwner: 'app_human', unread: true, curseur: '2026-10-21T08:42:00Z', signaleeMain: false },
  { id: 'c3', waId: '33639980103', profileName: 'Inès Petit', lastPreview: 'Je peux passer la retirer samedi ?', lastMessageAt: '2026-10-21T08:15:00Z', controlOwner: 'app_human', unread: true, curseur: '2026-10-21T08:15:00Z', signaleeMain: false },
  { id: 'c2', waId: '33639980102', profileName: 'Hugo Bernard', lastPreview: 'Merci pour l’info !', lastMessageAt: '2026-10-21T07:58:00Z', controlOwner: 'app_human', unread: false, curseur: '2026-10-21T07:58:00Z', signaleeMain: false },
];
const L = { fr: { compte: /lea@votre-marque\.test/ }, en: { compte: /lea@votre-marque\.test/ } } as const;

for (const locale of ['fr', 'en'] as Locale[]) {
  test.describe(locale, () => {
    test.use(NAVIGATEUR[locale]);

    test(`${CLE} (${locale}) : Console et menu Compte`, async ({ page }) => {
      await langue(page, locale);
      await mockAccueil(page, { account: COMPTE, settings: REGLAGES_ACCUEIL });
      await chiffresAccueil(page);
      await communs(page);
      await page.reload();
      await expect(page.getByTestId('numero-card')).toBeVisible();
      // 1. L'onglet Console, et son menu à gauche.
      await capturer(page, CLE, 1, locale);
      // 4. Le menu Compte, en haut à droite.
      await page.getByRole('button', { name: L[locale].compte }).click();
      await capturer(page, CLE, 4, locale);
    });

    test(`${CLE} (${locale}) : Inbox`, async ({ page }) => {
      await langue(page, locale);
      await page.route('**/api/backend/**', async (route) => {
        const url = route.request().url();
        const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
        if (/\/conversations\/counts/.test(url)) return json({ tout: 3, aTraiter: 2, signalees: 0, archivees: 0, traitees: 1, nonAffectees: 2, parMembre: [] });
        if (/\/conversations\?|\/conversations$/.test(url)) return json({ conversations: CONVERSATIONS });
        return json({});
      });
      await communs(page);
      await page.goto('/inbox');
      await expect(page.getByText('Léa Martin').first()).toBeVisible();
      // 2. L'onglet Inbox : ses dossiers, à la manière d'une boîte mail.
      await capturer(page, CLE, 2, locale);
    });

    test(`${CLE} (${locale}) : Performance Lab`, async ({ page }) => {
      await langue(page, locale);
      await page.route('**/api/backend/**', async (route) => {
        const chemin = new URL(route.request().url()).pathname;
        const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
        if (chemin.endsWith('/stats')) return json(STATS_DEMO);
        return json({});
      });
      await communs(page);
      await page.goto('/dashboard');
      // 3. Le Performance Lab, pour lire les résultats.
      await capturer(page, CLE, 3, locale);
    });

    test(`${CLE} (${locale}) : Paramètres`, async ({ page }) => {
      await langue(page, locale);
      await page.route('**/api/backend/**', async (route) => {
        const url = route.request().url();
        const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
        if (url.endsWith('/settings')) return json(REGLAGES_DEMO);
        return json({});
      });
      await communs(page);
      await page.goto('/parametres');
      // 5. Paramètres > Général : le fuseau et les heures d'ouverture.
      await capturer(page, CLE, 5, locale);
    });
  });
}
