import { test, expect, type Page } from './aide/test';

/**
 * LE PRO DIT EN CLAIR SUR LA PAGE OFFRE (2026-10-26) : la carte « Votre abonnement » (statut, formule, dates), résilier
 * avec une confirmation datée, annuler la résiliation, « Vos factures », et les deux onglets Offre et Crédit IA, que la
 * Free n'a pas. Le serveur est simulé : la résiliation réécrit l'abonnement que la vue suivante rend, comme en vrai.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const PRO = ['inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'email', 'console'];
const limites = (o: 'free' | 'pro' | 'entreprise') => ({
  utilisateurs: o === 'free' ? 1 : o === 'pro' ? 3 : null, admins: o === 'free' ? 1 : o === 'pro' ? 2 : null,
  contacts: o === 'free' ? 100 : o === 'pro' ? 5000 : null, envoisModelesMois: o === 'free' ? 1000 : null, automations: o === 'free' ? 10 : null,
  suppressionsJour: o === 'free' ? 10 : null, adressesWebhook: o === 'free' ? 1 : 5, journalWebhooksJours: o === 'free' ? 3 : 30,
  conservationJours: o === 'free' ? 30 : 90, commissionPct: o === 'free' ? 100 : o === 'pro' ? 20 : 10, badge: o === 'free', numeroInclus: o !== 'free',
});
const GRILLE = {
  free: { fonctions: [], limites: limites('free') },
  pro: { fonctions: PRO, limites: limites('pro') },
  entreprise: { fonctions: [...PRO, 'analyse', 'publicites', 'chaines', 'crm', 'rcs', 'performance_lab'], limites: limites('entreprise') },
};
const ACTIF = {
  statut: 'actif', periodicite: 'mois', debutLe: '2026-09-14T09:00:00.000Z', prochaineEcheanceLe: '2099-11-14T09:00:00.000Z',
  finPrevueLe: null, essaiFinLe: null, finiLe: null, finRaison: null,
};
const vuePro = (abonnement: unknown) => ({
  offre: 'pro', fonctions: PRO, limites: limites('pro'), usage: { envoisModelesMois: null, contacts: 120, automations: 3, membres: 2 },
  grille: GRILLE, prixPro: { moisCentimes: 4900, anCentimes: 49000 }, prixSiege: { moisCentimes: 1500, anCentimes: 15000 },
  essai: { jours: 14, possible: false, finLe: null }, sieges: { inclus: 3, achetes: 0, periodicite: 'mois' }, suiteDuNumero: null,
  abonnement, upgradeUrl: 'https://console.e2e.test/offre',
});
const FACTURES = {
  plusSurStripe: true,
  factures: [
    { id: 'in_2', numero: 'MM-0002', le: '2026-10-14T09:00:00.000Z', objet: 'pro', libelle: null, totalCentimes: 5880, devise: 'eur', statut: 'payee', urlPage: 'https://invoice.stripe.com/i/2', urlPdf: 'https://pay.stripe.com/invoice/2/pdf' },
    { id: 'in_1', numero: 'MM-0001', le: '2026-09-30T10:00:00.000Z', objet: 'autre', libelle: 'Recharge du crédit IA 5 € HT', totalCentimes: 600, devise: 'eur', statut: 'a_regler', urlPage: 'https://invoice.stripe.com/i/1', urlPdf: null },
  ],
};

async function monter(page: Page, o: { vue: unknown; resiliation?: { status: number; corps: unknown } }) {
  const resiliations: unknown[] = [];
  let vue = o.vue as ReturnType<typeof vuePro>;
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname;
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && chemin.endsWith('/offre/resiliation')) {
      const corps = req.postDataJSON() as { resilier: boolean };
      resiliations.push(corps);
      if (o.resiliation) return json(o.resiliation.corps, o.resiliation.status);
      // Le serveur pose la fin à la fin de la période, ou la retire : la vue suivante le dit.
      const fin = corps.resilier ? vue.abonnement && (vue.abonnement as typeof ACTIF).prochaineEcheanceLe : null;
      vue = vuePro(corps.resilier
        ? { ...ACTIF, statut: 'resiliation_programmee', prochaineEcheanceLe: null, finPrevueLe: fin }
        : ACTIF);
      return json({ finPrevueLe: fin });
    }
    if (chemin.endsWith('/offre/factures')) return json(FACTURES);
    if (chemin.endsWith('/offre')) return json(vue);
    if (chemin.endsWith('/agents/solde')) return json({ soldeMicroEur: 3_000_000 });
    if (chemin.endsWith('/agents/mouvements')) return json({ mouvements: [] });
    if (chemin.endsWith('/unread-count')) return json({ count: 0 });
    if (chemin.endsWith('/me')) return json({ email: SESSION.email, name: 'Jean Test', role: 'admin' });
    return json({});
  });
  return { resiliations };
}

test.describe('la carte « Votre abonnement »', () => {
  test('🔴 un Pro qui court : statut, formule et prix, souscription, renouvellement, et aucune fin', async ({ page }) => {
    await monter(page, { vue: vuePro(ACTIF) });
    await page.goto('/offre');
    const carte = page.getByTestId('offre-abonnement-pro');
    await expect(carte).toHaveAttribute('data-statut', 'actif');
    await expect(page.getByTestId('offre-abonnement-statut')).toHaveText('Actif');
    await expect(carte.getByTestId('offre-abonnement-formule')).toContainText('Mensuel, 49 € HT par mois');
    await expect(carte.getByTestId('offre-abonnement-debut')).toContainText('14 septembre 2026');
    await expect(carte.getByTestId('offre-abonnement-echeance')).toContainText('14 novembre 2099');
    await expect(carte.getByTestId('offre-abonnement-fin')).toContainText('il se renouvelle chaque mois');
    // L'ancien bloc (« Gérer mon abonnement ») n'est plus là quand l'API rend l'abonnement.
    await expect(page.getByTestId('offre-abonnement')).toHaveCount(0);
  });

  test('🔴 résilier se confirme avec la date de fin, puis la carte dit « résiliation programmée » ; annuler la retire', async ({ page }) => {
    const m = await monter(page, { vue: vuePro(ACTIF) });
    await page.goto('/offre');
    await page.getByTestId('offre-resilier').click();
    await expect(page.getByTestId('confirmation-message')).toContainText('jusqu’au 14 novembre 2099');
    await expect(page.getByTestId('confirmation-message')).toContainText('Rien n’est remboursé');
    await page.getByTestId('confirmation-oui').click();
    await expect(page.getByTestId('offre-abonnement-pro')).toHaveAttribute('data-statut', 'resiliation_programmee');
    await expect(page.getByTestId('offre-abonnement-resilie')).toContainText('jusqu’au 14 novembre 2099');
    await expect(page.getByTestId('offre-abonnement-echeance')).toHaveCount(0);

    await page.getByTestId('offre-reprendre').click();
    await expect(page.getByTestId('offre-abonnement-pro')).toHaveAttribute('data-statut', 'actif');
    await expect(page.getByTestId('offre-resilier')).toBeVisible();
    expect(m.resiliations).toEqual([{ resilier: true }, { resilier: false }]);
  });

  test('renoncer dans la confirmation ne résilie rien', async ({ page }) => {
    const m = await monter(page, { vue: vuePro(ACTIF) });
    await page.goto('/offre');
    await page.getByTestId('offre-resilier').click();
    await page.getByTestId('confirmation-non').click();
    await expect(page.getByTestId('offre-abonnement-pro')).toHaveAttribute('data-statut', 'actif');
    expect(m.resiliations).toEqual([]);
  });

  test('un refus du serveur se dit sous la carte, et rien ne change', async ({ page }) => {
    await monter(page, {
      vue: vuePro(ACTIF),
      resiliation: { status: 422, corps: { error: 'La résiliation n’a pas pu être enregistrée chez Stripe. Réessayez dans un instant ; si cela persiste, contactez-nous.', code: 'resiliation_impossible' } },
    });
    await page.goto('/offre');
    await page.getByTestId('offre-resilier').click();
    await page.getByTestId('confirmation-oui').click();
    await expect(page.getByTestId('offre-abonnement-erreur')).toContainText('n’a pas pu être enregistrée');
    await expect(page.getByTestId('offre-abonnement-pro')).toHaveAttribute('data-statut', 'actif');
  });

  test('🔴 un essai : sa fin, le premier paiement, et « vous ne serez pas prélevé » dans la confirmation', async ({ page }) => {
    await monter(page, { vue: vuePro({ ...ACTIF, statut: 'essai', essaiFinLe: '2099-11-01T09:00:00.000Z', prochaineEcheanceLe: '2099-11-01T09:00:00.000Z' }) });
    await page.goto('/offre');
    await expect(page.getByTestId('offre-abonnement-statut')).toHaveText('Essai gratuit');
    await expect(page.getByTestId('offre-essai-fin')).toContainText('1 novembre 2099');
    await expect(page.getByTestId('offre-abonnement-echeance')).toContainText('Premier paiement');
    await page.getByTestId('offre-resilier').click();
    await expect(page.getByTestId('confirmation-message')).toContainText('Vous ne serez pas prélevé');
  });

  test('un paiement en retard le dit, et met « Changer de carte bancaire » en avant', async ({ page }) => {
    await monter(page, { vue: vuePro({ ...ACTIF, statut: 'en_retard', prochaineEcheanceLe: null }) });
    await page.goto('/offre');
    await expect(page.getByTestId('offre-abonnement-statut')).toHaveText('Paiement en retard');
    await expect(page.getByTestId('offre-abonnement-retard')).toBeVisible();
    await expect(page.getByTestId('offre-portail')).toBeVisible();
  });
});

test.describe('« Vos factures »', () => {
  test('🔴 chaque facture : son objet, sa date, son montant TTC, son statut, et ses liens vers Stripe', async ({ page }) => {
    await monter(page, { vue: vuePro(ACTIF) });
    await page.goto('/offre');
    const lignes = page.getByTestId('offre-facture');
    await expect(lignes).toHaveCount(2);
    await expect(lignes.nth(0)).toContainText('Abonnement Pro');
    await expect(lignes.nth(0)).toContainText('58,80');
    await expect(lignes.nth(0)).toContainText('Payée');
    await expect(lignes.nth(0).getByTestId('offre-facture-pdf')).toHaveAttribute('href', 'https://pay.stripe.com/invoice/2/pdf');
    await expect(lignes.nth(1)).toContainText('Recharge du crédit IA 5 € HT');
    await expect(lignes.nth(1)).toContainText('À régler');
    await expect(lignes.nth(1).getByTestId('offre-facture-voir')).toHaveText('Régler');
    await expect(lignes.nth(1).getByTestId('offre-facture-pdf')).toHaveCount(0);
    await expect(page.getByTestId('offre-factures-plus')).toBeVisible();
  });
});

test.describe('les onglets Offre et Crédit IA', () => {
  test('🔴 un Pro a les deux onglets : Crédit IA ouvre le crédit, avec ses quatre recharges', async ({ page }) => {
    await monter(page, { vue: vuePro(ACTIF) });
    await page.goto('/offre');
    await page.getByTestId('mba-tab-credit').click();
    await expect(page).toHaveURL(/\/offre\?tab=credit$/);
    await expect(page.getByTestId('credit-solde')).toContainText('3');
    for (const euros of [5, 10, 50, 100]) await expect(page.getByTestId(`credit-offre-refill_${euros}`)).toBeVisible();
    await page.getByTestId('mba-tab-offre').click();
    await expect(page.getByTestId('offre-abonnement-pro')).toBeVisible();
  });

  test('🔴 une Free n’a pas l’onglet Crédit IA, même par l’adresse', async ({ page }) => {
    await monter(page, {
      vue: { ...vuePro(null), offre: 'free', fonctions: [], limites: limites('free'), sieges: null, essai: { jours: 14, possible: true, finLe: null } },
    });
    await page.goto('/offre?tab=credit');
    await expect(page.getByTestId('offre-actuelle')).toHaveText('Free');
    await expect(page.getByTestId('mba-tab-credit')).toHaveCount(0);
    await expect(page.getByTestId('credit-solde')).toHaveCount(0);
  });
});
