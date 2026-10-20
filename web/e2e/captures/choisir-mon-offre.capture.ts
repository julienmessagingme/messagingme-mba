import type { Page } from '@playwright/test';
import { test, expect } from '../aide/test';
import { NAVIGATEUR, OFFRE_PRO, capturer, communs, langue, type Locale } from './donnees-demo';

/**
 * « Choisir mon offre » : la page Offre d'un espace Free (où il en est, et le passage en Pro avec son essai), puis
 * celle d'un espace Pro (« Gérer mon abonnement »). Les prix sont ceux du code (`PRIX_PRO_HT_CENTIMES`) ; rien n'est
 * payé, le bouton de paiement n'est pas cliqué.
 */
const CLE = 'choisir-mon-offre';
const PRIX_PRO = { moisCentimes: 4900, anCentimes: 49000 };
const PRIX_SIEGE = { moisCentimes: 1500, anCentimes: 15000 };
const L = {
  fr: { gerer: /Gérer mon abonnement/ },
  en: { gerer: /Manage my subscription/ },
} as const;

const free = {
  ...OFFRE_PRO, offre: 'free', fonctions: [], limites: OFFRE_PRO.grille.free.limites,
  usage: { envoisModelesMois: 236, contacts: 74, automations: 2, membres: 1 },
  prixPro: PRIX_PRO, prixSiege: PRIX_SIEGE, essai: { jours: 14, possible: true, finLe: null }, sieges: null, suiteDuNumero: null,
};
const pro = {
  ...OFFRE_PRO, prixPro: PRIX_PRO, prixSiege: PRIX_SIEGE, essai: { jours: 14, possible: false, finLe: null },
  sieges: { inclus: 3, achetes: 0, periodicite: 'mois' }, suiteDuNumero: null,
};

async function offre(page: Page, vue: unknown): Promise<void> {
  await page.route('**/api/backend/**/offre', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(vue) }));
}

for (const locale of ['fr', 'en'] as Locale[]) {
  test.describe(locale, () => {
    test.use(NAVIGATEUR[locale]);

    test(`${CLE} (${locale}) : espace Free`, async ({ page }) => {
      await langue(page, locale);
      await page.route('**/api/backend/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
      await communs(page);
      await offre(page, free);
      await page.goto('/offre');
      await expect(page.getByTestId('offre-essai')).toBeVisible();

      // 1. Où en est l'espace : son offre, ce qu'il consomme, la grille.
      await capturer(page, CLE, 1, locale);
      // 2. Passer en Pro : mensuel ou annuel, et l'essai de 14 jours.
      await capturer(page, CLE, 2, locale, page.getByTestId('offre-essai'), 'bas');
    });

    test(`${CLE} (${locale}) : espace Pro`, async ({ page }) => {
      await langue(page, locale);
      await page.route('**/api/backend/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
      await communs(page);
      await offre(page, pro);
      await page.goto('/offre');
      // 3. Gérer mon abonnement, depuis un espace en Pro.
      const gerer = page.getByRole('button', { name: L[locale].gerer });
      await expect(gerer).toBeVisible();
      await capturer(page, CLE, 3, locale);
    });
  });
}
