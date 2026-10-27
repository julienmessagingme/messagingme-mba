import type { Page } from '@playwright/test';
import { test, expect } from '../aide/test';
import { NAVIGATEUR, OFFRE_PRO, PRIX_DEMO, capturer, communs, langue, type Locale } from './donnees-demo';

/**
 * « Choisir mon offre » : la page Offre d'un espace Free (où il en est, et le passage en Pro avec son essai), puis
 * celle d'un espace Pro (la carte « Votre abonnement », puis « Vos factures », 2026-10-26). Les prix sont ceux du code
 * (`PRIX_PRO_HT_CENTIMES`) ; rien n'est payé ni résilié, aucun bouton n'est cliqué.
 */
const CLE = 'choisir-mon-offre';

const free = {
  ...OFFRE_PRO, offre: 'free', fonctions: [], limites: OFFRE_PRO.grille.free.limites,
  usage: { envoisModelesMois: 236, contacts: 74, automations: 2, membres: 1 },
  prixPro: PRIX_DEMO.pro, prixSiege: PRIX_DEMO.siege, prixBusiness: PRIX_DEMO.business, essai: { jours: PRIX_DEMO.essaiJours, possible: true, finLe: null }, sieges: null,
  suiteDuNumero: null,
};
const pro = {
  ...OFFRE_PRO, prixPro: PRIX_DEMO.pro, prixSiege: PRIX_DEMO.siege, prixBusiness: PRIX_DEMO.business, essai: { jours: PRIX_DEMO.essaiJours, possible: false, finLe: null },
  sieges: { inclus: OFFRE_PRO.limites.utilisateurs, achetes: 0, periodicite: 'mois' }, suiteDuNumero: null,
  abonnement: {
    statut: 'actif', periodicite: 'mois', debutLe: '2026-09-14T09:00:00.000Z', prochaineEcheanceLe: '2026-11-14T09:00:00.000Z',
    finPrevueLe: null, essaiFinLe: null, finiLe: null, finRaison: null,
  },
};

/** Les factures de l'espace de démonstration : deux mois de Pro et une recharge, toutes payées. */
const FACTURES = {
  plusSurStripe: false,
  factures: [
    { id: 'in_demo3', numero: 'VM-0003', le: '2026-10-14T09:00:00.000Z', objet: 'pro', libelle: null, totalCentimes: 5880, devise: 'eur', statut: 'payee', urlPage: 'https://invoice.stripe.com/i/demo3', urlPdf: 'https://pay.stripe.com/invoice/demo3/pdf' },
    { id: 'in_demo2', numero: 'VM-0002', le: '2026-09-28T15:20:00.000Z', objet: 'autre', libelle: 'Recharge du crédit IA 10 € HT', totalCentimes: 1200, devise: 'eur', statut: 'payee', urlPage: 'https://invoice.stripe.com/i/demo2', urlPdf: 'https://pay.stripe.com/invoice/demo2/pdf' },
    { id: 'in_demo1', numero: 'VM-0001', le: '2026-09-14T09:00:00.000Z', objet: 'pro', libelle: null, totalCentimes: 5880, devise: 'eur', statut: 'payee', urlPage: 'https://invoice.stripe.com/i/demo1', urlPdf: 'https://pay.stripe.com/invoice/demo1/pdf' },
  ],
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
      await capturer(page, CLE, 2, locale, page.getByTestId('offre-essai'));
    });

    test(`${CLE} (${locale}) : espace Pro`, async ({ page }) => {
      await langue(page, locale);
      await page.route('**/api/backend/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
      await communs(page);
      await offre(page, pro);
      await page.route('**/api/backend/**/offre/factures', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACTURES) }));
      await page.goto('/offre');
      // 3. Suivre et résilier son abonnement : la carte « Votre abonnement », en tête de la page.
      const carte = page.getByTestId('offre-abonnement-pro');
      await expect(carte).toBeVisible();
      await capturer(page, CLE, 3, locale, carte, 'haut', page.getByTestId('offre-resilier'));
      // 4. Retrouver ses factures.
      const factures = page.getByTestId('offre-factures');
      await expect(factures.getByTestId('offre-facture')).toHaveCount(3);
      await capturer(page, CLE, 4, locale, factures, 'haut', factures.getByTestId('offre-facture-pdf').first());
    });
  });
}
