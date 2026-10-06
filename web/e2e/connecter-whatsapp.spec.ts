import { test, expect, type Page } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * « Connecter WhatsApp » (lot 3b) : le numéro fourni par la réserve, puis le code que l'Asterisk capte quand Meta
 * appelle ce numéro. Le serveur est simulé : la page attribue, affiche, puis lit le code en boucle.
 */
const SANS_NUMERO = { hasNumber: false, phoneNumberId: null, number: null, numberStatus: null, codeVerificationStatus: null, status: { dot: 'grey', label: 'Aucun numéro', reason: 'Aucun numéro connecté.' } };

/** Le numéro fourni côté serveur : rien d'attribué au départ, puis le code arrive au bout de `lecturesAvantCode` lectures. */
async function simulerNumeroFourni(page: Page, o: { lecturesAvantCode?: number; abonnement?: 'actif' | null } = {}) {
  const etat = {
    numero: null as string | null, lectures: 0, gestes: [] as string[],
    abonnement: (o.abonnement === undefined ? 'actif' : o.abonnement) as 'actif' | null, retours: [] as string[],
  };
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  // L'état de la connexion (lot 3c) : l'abonnement du numéro, et le numéro attribué.
  await page.route('**/api/backend/tenants/*/connexion-numero', (route) => route.fulfill(json({
    etat: { fourni: etat.numero, code: null, connecte: null, abonnement: etat.abonnement ? { statut: etat.abonnement, periodeFin: null } : null },
    empreinte: '0123456789abcdef',
  })));
  await page.route('**/api/backend/tenants/*/numero-fourni**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname;
    if (req.method() === 'POST' && chemin.endsWith('/abonnement')) {
      etat.gestes.push('payer');
      etat.retours.push((req.postDataJSON() as { retour: string }).retour);
      // Une adresse de la page elle-même : le test ne quitte pas l'application pour Stripe.
      return route.fulfill(json({ url: '/connecter-whatsapp?abonnement=recu' }));
    }
    if (req.method() === 'POST' && chemin.endsWith('/numero-fourni')) {
      etat.gestes.push('obtenir');
      etat.numero = '+441235619343';
      return route.fulfill(json({ numero: etat.numero }));
    }
    if (req.method() === 'POST' && chemin.endsWith('/remplacer')) {
      etat.gestes.push('remplacer');
      etat.numero = '+442071234567';
      etat.lectures = 0;
      return route.fulfill(json({ numero: etat.numero }));
    }
    if (req.method() === 'GET') {
      if (etat.numero === null) return route.fulfill(json({ numero: null, code: null, codeRecuLe: null }));
      etat.lectures += 1;
      const code = etat.lectures > (o.lecturesAvantCode ?? 1) ? '345679' : null;
      return route.fulfill(json({ numero: etat.numero, code, codeRecuLe: code ? '2026-10-06T10:00:00.000Z' : null }));
    }
    return route.fulfill(json({}));
  });
  return etat;
}

test('🔴 numéro fourni : il s’affiche, puis le code capté apparaît sans rien recharger', async ({ page }) => {
  await mockAccueil(page, { account: SANS_NUMERO, inscription: { complete: {} } });
  const etat = await simulerNumeroFourni(page, { lecturesAvantCode: 1 });
  await page.goto('/connecter-whatsapp');

  await page.getByTestId('choix-fourni').click();
  await page.getByTestId('obtenir-numero').click();
  await expect(page.getByTestId('numero-fourni')).toHaveText('+441235619343');
  await expect(page.getByTestId('code-capte')).toContainText('En attente de l’appel de Meta');
  // La page lit le code toutes les 3 secondes : il arrive sans geste du client.
  await expect(page.getByTestId('code-capte')).toContainText('345679', { timeout: 12_000 });
  await expect(page.getByTestId('ouvrir-fenetre-meta')).toBeEnabled();
  expect(etat.gestes).toEqual(['obtenir']);
});

test('« Meta refuse ce numéro » : un autre numéro remplace le premier', async ({ page }) => {
  await mockAccueil(page, { account: SANS_NUMERO, inscription: { complete: {} } });
  const etat = await simulerNumeroFourni(page, { lecturesAvantCode: 100 });
  await page.goto('/connecter-whatsapp');
  await page.getByTestId('choix-fourni').click();
  await page.getByTestId('obtenir-numero').click();
  await expect(page.getByTestId('numero-fourni')).toHaveText('+441235619343');
  await page.getByTestId('remplacer-numero').click();
  await expect(page.getByTestId('numero-fourni')).toHaveText('+442071234567');
  expect(etat.gestes).toEqual(['obtenir', 'remplacer']);
});

test('un numéro déjà attribué reprend où il en était au retour sur la page', async ({ page }) => {
  await mockAccueil(page, { account: SANS_NUMERO, inscription: { complete: {} } });
  const etat = await simulerNumeroFourni(page);
  etat.numero = '+441235619343';
  await page.goto('/connecter-whatsapp');
  await expect(page.getByTestId('numero-fourni')).toHaveText('+441235619343');
  expect(etat.gestes).toEqual([]);
});

test('🔴 sans abonnement : le prix et « Payer », puis la page de paiement ; aucun numéro avant', async ({ page }) => {
  await mockAccueil(page, { account: SANS_NUMERO, inscription: { complete: {} } });
  const etat = await simulerNumeroFourni(page, { abonnement: null });
  await page.goto('/connecter-whatsapp');
  await page.getByTestId('choix-fourni').click();
  await expect(page.getByTestId('obtenir-numero')).toHaveCount(0);
  await expect(page.getByTestId('payer-numero')).toContainText('3,50');
  await page.getByTestId('payer-numero').click();
  await expect(page).toHaveURL(/abonnement=recu/);
  expect(etat.gestes).toEqual(['payer']);
  expect(etat.retours).toEqual(['console']);
});

test('🔴 retour de Stripe avant le webhook : « confirmation en cours », et pas de second paiement', async ({ page }) => {
  await mockAccueil(page, { account: SANS_NUMERO, inscription: { complete: {} } });
  const etat = await simulerNumeroFourni(page, { abonnement: null });
  await page.goto('/connecter-whatsapp?abonnement=recu');
  await page.getByTestId('choix-fourni').click();
  await expect(page.getByTestId('paiement-en-confirmation')).toBeVisible();
  await expect(page.getByTestId('payer-numero')).toHaveCount(0);
  // Le webhook passe : l'abonnement est actif et le numéro attribué ; la page le montre sans rien recharger.
  etat.abonnement = 'actif';
  etat.numero = '+441235619343';
  await expect(page.getByTestId('numero-fourni')).toHaveText('+441235619343', { timeout: 12_000 });
  expect(etat.gestes).toEqual([]);
});

test('payé, mais la réserve était vide : « en préparation »', async ({ page }) => {
  await mockAccueil(page, { account: SANS_NUMERO, inscription: { complete: {} } });
  await simulerNumeroFourni(page, { abonnement: 'actif' });
  await page.goto('/connecter-whatsapp');
  await page.getByTestId('choix-fourni').click();
  await expect(page.getByTestId('numero-en-preparation')).toBeVisible();
});

test('espace déjà connecté : la page le dit, aucun choix', async ({ page }) => {
  await mockAccueil(page);
  await page.goto('/connecter-whatsapp');
  await expect(page.getByTestId('numero-connecte')).toBeVisible();
  await expect(page.getByTestId('choix-fourni')).toHaveCount(0);
});
