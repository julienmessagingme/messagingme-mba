import { test, expect, type Page } from '@playwright/test';

/**
 * LA PAGE CRÉDIT IA : recharger par Stripe, revenir, et lire ce qui a fait bouger le solde.
 *
 * 🔴 CE QUE SEUL UN TEST DE BOUT EN BOUT VOIT ICI. La route de paiement et le webhook sont tenus par leurs tests
 * serveur. Ce qui reste est à l'écran : que le clic parte bien vers la page de Stripe, que le RETOUR ne se prenne
 * pas pour un crédit (il dit « le crédit arrive » et relit le solde), et surtout qu'une route ABSENTE (la console
 * part sur Vercel avant l'API) ou non configurée dise « recharge pas encore disponible » au lieu d'une erreur brute.
 * Aucun appel ne part chez Stripe : la page de paiement est interceptée.
 */
const ADMIN = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const PAGE_STRIPE = 'https://checkout.stripe.com/c/pay/cs_test_e2e';

const PAGE_FACTURE = 'https://invoice.stripe.com/i/acct_e2e/in_e2e';

// Un achat ANCIEN (la veille) : au retour d'un paiement, il n'est pas celui qu'on attend. Il a sa facture.
const MOUVEMENTS = [
  { id: 'a1', deltaMicroEur: 50_000_000, raison: 'achat', jour: null, at: '2026-09-28T19:00:00.000Z', paiementId: 'cs_live_e2e', facture: true },
  { id: 'agents-2026-09-28', deltaMicroEur: -1_234_500, raison: 'conso', jour: '2026-09-28', at: '2026-09-28T18:00:00.000Z' },
  { id: 't1', deltaMicroEur: -42_000, raison: 'traduction', jour: '2026-09-28', at: '2026-09-28T17:00:00.000Z' },
  { id: 'o1', deltaMicroEur: 5_000_000, raison: 'offert', jour: null, at: '2026-09-20T09:00:00.000Z' },
  { id: 'r1', deltaMicroEur: 10_000_000, raison: 'recharge', jour: null, at: '2026-09-10T09:00:00.000Z' },
];

interface Options {
  session?: typeof ADMIN;
  /** Les soldes successifs rendus par le serveur (le dernier se répète). */
  soldes?: number[];
  /** La réponse de la route de paiement. */
  paiement?: { status: number; body: unknown };
  /** Les historiques successifs rendus par le serveur (le dernier se répète). */
  historiques?: unknown[][];
  /** La réponse de la route de facture. */
  facture?: { status: number; body: unknown };
}

async function monter(page: Page, o: Options = {}) {
  const demandes: unknown[] = [];
  const soldes = [...(o.soldes ?? [4_200_000])];
  const historiques = [...(o.historiques ?? [MOUVEMENTS])];
  let lectures = 0;
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), o.session ?? ADMIN);
  await page.route(`${PAGE_STRIPE}**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe Checkout (e2e)</h1>' }));
  // L'onglet de la facture est une page du même contexte : la page hébergée par Stripe y est interceptée aussi.
  await page.context().route(`${PAGE_FACTURE}**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Facture Stripe (e2e)</h1>' }));
  const factures: string[] = [];
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/credit/factures/')) {
      factures.push(url);
      const f = o.facture ?? { status: 200, body: { url: PAGE_FACTURE } };
      return json(f.body, f.status);
    }
    if (url.includes('/credit/paiement') && req.method() === 'POST') {
      demandes.push(req.postDataJSON());
      const p = o.paiement ?? { status: 200, body: { url: PAGE_STRIPE } };
      return json(p.body, p.status);
    }
    if (url.includes('/agents/solde')) {
      lectures += 1;
      return json({ soldeMicroEur: soldes.length > 1 ? soldes.shift()! : soldes[0]! });
    }
    if (url.includes('/agents/mouvements')) return json({ mouvements: historiques.length > 1 ? historiques.shift()! : historiques[0]! });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: ADMIN.email, name: 'Jean Test', role: 'admin' });
    return json({});
  });
  return { demandes, factures, lectures: () => lectures };
}

test.describe('Paramètres > Crédit IA', () => {
  test('🔴 deux boutons HT ; un clic ouvre la page de paiement de Stripe pour CETTE offre', async ({ page }) => {
    const m = await monter(page);
    await page.goto('/parametres/credit');
    await expect(page.getByTestId('credit-solde')).toContainText('4.2');
    await expect(page.getByTestId('credit-offre-refill_50')).toHaveText(/Recharger 50 € HT/);
    await expect(page.getByTestId('credit-offre-refill_100')).toHaveText(/Recharger 100 € HT/);

    await page.getByTestId('credit-offre-refill_100').click();
    await expect(page).toHaveURL(PAGE_STRIPE);
    // Le corps ne porte qu'une offre, jamais un montant.
    expect(m.demandes).toEqual([{ offre: 'refill_100' }]);
  });

  test('🔴 le RETOUR de paiement ne crédite rien : il annonce le crédit, puis relit jusqu’à voir l’achat', async ({ page }) => {
    // Le webhook passe entre la première et la deuxième lecture : le solde monte de 50 €, la ligne `achat` apparaît.
    const achat = { id: 'a2', deltaMicroEur: 50_000_000, raison: 'achat', jour: null, at: new Date().toISOString() };
    const m = await monter(page, { soldes: [1_000_000, 51_000_000], historiques: [MOUVEMENTS, [achat, ...MOUVEMENTS]] });
    await page.goto('/parametres/credit?paiement=recu');
    await expect(page.getByTestId('credit-retour-recu')).toContainText(/le crédit arrive dans quelques secondes/);
    await expect(page.getByTestId('credit-solde')).toContainText('51', { timeout: 10_000 });
    await expect(page.getByTestId('credit-retour-recu')).toContainText(/votre crédit est à jour/);
    expect(m.lectures()).toBeGreaterThanOrEqual(2);
  });

  test('🔴 le webhook passé AVANT la première lecture : « à jour » tout de suite, pas « le crédit arrive » pour toujours', async ({ page }) => {
    // Relecture du 2026-09-29 : le solde ne « montait » jamais pendant les relectures (il était déjà monté), et
    // l'écran gardait « le crédit arrive dans quelques secondes ». C'est la ligne `achat` qui dit l'arrivée.
    const achat = { id: 'a2', deltaMicroEur: 50_000_000, raison: 'achat', jour: null, at: new Date().toISOString() };
    await monter(page, { soldes: [51_000_000], historiques: [[achat, ...MOUVEMENTS]] });
    await page.goto('/parametres/credit?paiement=recu');
    await expect(page.getByTestId('credit-retour-recu')).toContainText(/votre crédit est à jour/);
  });

  test('un achat ANCIEN (le précédent) ne passe pas pour celui qu’on vient de payer', async ({ page }) => {
    await monter(page, { soldes: [4_200_000] });
    await page.goto('/parametres/credit?paiement=recu');
    await expect(page.getByTestId('credit-solde')).toContainText('4.2');
    await page.waitForTimeout(3_500); // une relecture passe
    await expect(page.getByTestId('credit-retour-recu')).toContainText(/le crédit arrive dans quelques secondes/);
  });

  test('un paiement abandonné le dit, sans rien créditer', async ({ page }) => {
    await monter(page);
    await page.goto('/parametres/credit?paiement=abandon');
    await expect(page.getByTestId('credit-retour-abandon')).toContainText(/rien n’a été débité/);
  });

  test('🔴 route ABSENTE (404, la console part avant l’API) : « recharge pas encore disponible », pas une erreur', async ({ page }) => {
    await monter(page, { paiement: { status: 404, body: { message: 'Route POST:/tenants/t-e2e/credit/paiement not found' } } });
    await page.goto('/parametres/credit');
    await page.getByTestId('credit-offre-refill_50').click();
    await expect(page.getByTestId('credit-indisponible')).toContainText(/pas encore disponible/);
    await expect(page.getByTestId('credit-erreur')).toHaveCount(0);
    await expect(page.getByTestId('credit-offre-refill_50')).toHaveCount(0);
  });

  test('🔴 Stripe pas configuré (503) : le même message', async ({ page }) => {
    await monter(page, { paiement: { status: 503, body: { error: 'recharge pas encore disponible', code: 'recharge_indisponible' } } });
    await page.goto('/parametres/credit');
    await page.getByTestId('credit-offre-refill_100').click();
    await expect(page.getByTestId('credit-indisponible')).toBeVisible();
  });

  test('une erreur de préparation du paiement s’affiche, lisible, et les boutons restent', async ({ page }) => {
    await monter(page, { paiement: { status: 422, body: { error: 'Le paiement n’a pas pu être préparé. Réessayez dans un instant ; si cela persiste, contactez-nous.', code: 'paiement_impossible' } } });
    await page.goto('/parametres/credit');
    await page.getByTestId('credit-offre-refill_50').click();
    await expect(page.getByTestId('credit-erreur')).toContainText(/n’a pas pu être préparé/);
    await expect(page.getByTestId('credit-offre-refill_50')).toBeEnabled();
  });

  test('🔴 l’historique dit chaque raison EN CLAIR', async ({ page }) => {
    await monter(page);
    await page.goto('/parametres/credit');
    const lignes = page.getByTestId('credit-ligne');
    await expect(lignes).toHaveCount(5);
    await expect(lignes.nth(0)).toContainText('Achat de crédit');
    await expect(lignes.nth(1)).toContainText('Agents IA du 28/09');
    await expect(lignes.nth(2)).toContainText('Traductions du 28/09');
    await expect(lignes.nth(3)).toContainText('Crédit offert');
    await expect(lignes.nth(4)).toContainText('Recharge manuelle');
    await expect(page.getByTestId('credit-historique')).not.toContainText(/conso|achat\b/);
  });

  test('🔴 « Facture » sur un achat qui en a une : un onglet s’ouvre dans le clic, puis va sur la facture de CE paiement', async ({ page }) => {
    const m = await monter(page);
    await page.goto('/parametres/credit');
    const liens = page.getByTestId('credit-facture');
    // Un seul achat a une facture : aucune autre ligne n'offre le lien.
    await expect(liens).toHaveCount(1);
    await expect(page.getByTestId('credit-ligne').nth(0).getByTestId('credit-facture')).toHaveText('Facture');
    const onglet = page.waitForEvent('popup');
    await liens.click();
    const facture = await onglet;
    await expect(facture).toHaveURL(PAGE_FACTURE);
    await expect(facture.getByRole('heading')).toHaveText('Facture Stripe (e2e)');
    expect(m.factures).toHaveLength(1);
    expect(m.factures[0]).toContain('/tenants/t-e2e/credit/factures/cs_live_e2e');
    await expect(page.getByTestId('credit-facture-erreur')).toHaveCount(0);
  });

  test('🔴 une facture qui ne s’ouvre pas : l’onglet vide se referme, et la page le dit', async ({ page }) => {
    await monter(page, { facture: { status: 422, body: { error: 'La facture n’a pas pu être ouverte. Réessayez dans un instant ; si cela persiste, contactez-nous.', code: 'facture_impossible' } } });
    await page.goto('/parametres/credit');
    const onglet = page.waitForEvent('popup');
    await page.getByTestId('credit-facture').click();
    const vide = await onglet;
    await expect.poll(() => vide.isClosed()).toBe(true);
    await expect(page.getByTestId('credit-facture-erreur')).toContainText(/n’a pas pu être ouverte/);
  });

  test('un achat sans facture, ou d’une API plus ancienne : aucun lien', async ({ page }) => {
    await monter(page, { historiques: [[
      { id: 'a1', deltaMicroEur: 50_000_000, raison: 'achat', jour: null, at: '2026-09-28T19:00:00.000Z', paiementId: 'cs_live_e2e', facture: false },
      { id: 'a0', deltaMicroEur: 50_000_000, raison: 'achat', jour: null, at: '2026-09-27T19:00:00.000Z' },
    ]] });
    await page.goto('/parametres/credit');
    await expect(page.getByTestId('credit-ligne')).toHaveCount(2);
    await expect(page.getByTestId('credit-facture')).toHaveCount(0);
  });

  test('🔴 un compte NON ADMIN n’y entre pas : aucun bouton de paiement ne lui est offert', async ({ page }) => {
    const m = await monter(page, { session: { ...ADMIN, email: 'agent@e2e.test', role: 'agent' } });
    await page.goto('/parametres/credit');
    await expect(page).toHaveURL(/\/inbox/);
    await expect(page.getByTestId('credit-offre-refill_50')).toHaveCount(0);
    expect(m.demandes).toEqual([]);
  });
});
