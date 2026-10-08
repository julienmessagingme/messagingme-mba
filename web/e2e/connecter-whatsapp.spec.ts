import { test, expect, type Page } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * « Connecter WhatsApp » (lot 3b) : le numéro fourni par la réserve, puis le code que l'Asterisk capte quand Meta
 * appelle ce numéro. Le serveur est simulé : la page attribue, affiche, puis lit le code en boucle.
 */
const SANS_NUMERO = { hasNumber: false, phoneNumberId: null, number: null, numberStatus: null, codeVerificationStatus: null, status: { dot: 'grey', label: 'Aucun numéro', reason: 'Aucun numéro connecté.' } };

/** Le numéro fourni côté serveur : rien d'attribué au départ, puis le code arrive au bout de `lecturesAvantCode` lectures. */
async function simulerNumeroFourni(page: Page, o: {
  lecturesAvantCode?: number; abonnement?: 'actif' | 'resilie' | null;
  /** Le délai de la lecture du numéro, selon le numéro attribué à ce moment (la course de « Remplacer »). */
  delaiLecture?: (numero: string) => number;
  /** Le code que rend la lecture de ce numéro, à la place du code qui arrive au fil des lectures. */
  codeDe?: (numero: string) => string | null;
  /** « Abandonner » programme la fin de l'abonnement chez Stripe (lot 4, livraison B) ; absent = une API plus ancienne. */
  finProgrammee?: boolean;
  /** Un Pro vivant inclut le numéro (lot 6, B2b) ; absent = une API plus ancienne. */
  inclusDansLePro?: boolean;
} = {}) {
  const etat = {
    numero: null as string | null, lectures: 0, gestes: [] as string[],
    abonnement: (o.abonnement === undefined ? 'actif' : o.abonnement) as 'actif' | 'resilie' | null, retours: [] as string[],
  };
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  // L'état de la connexion (lot 3c) : l'abonnement du numéro, et le numéro attribué.
  await page.route('**/api/backend/tenants/*/connexion-numero', (route) => route.fulfill(json({
    etat: {
      fourni: etat.numero, code: null, connecte: null, abonnement: etat.abonnement ? { statut: etat.abonnement, periodeFin: null } : null,
      ...(o.inclusDansLePro === undefined ? {} : { inclusDansLePro: o.inclusDansLePro }),
    },
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
    if (req.method() === 'POST' && chemin.endsWith('/portail')) {
      etat.gestes.push('portail');
      return route.fulfill(json({ url: '/connecter-whatsapp?portail=ouvert' }));
    }
    if (req.method() === 'POST' && chemin.endsWith('/abandonner')) {
      etat.gestes.push('abandonner');
      const rendu = etat.numero !== null;
      etat.numero = null;
      return route.fulfill(json(o.finProgrammee === undefined ? { rendu } : { rendu, finProgrammee: o.finProgrammee }));
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
      // La réponse décrit le serveur au moment de la LECTURE : une réponse lente arrive avec l'état d'avant.
      const numero = etat.numero;
      const code = o.codeDe ? o.codeDe(numero) : etat.lectures > (o.lecturesAvantCode ?? 1) ? '345679' : null;
      const delai = o.delaiLecture?.(numero) ?? 0;
      if (delai > 0) await new Promise((r) => setTimeout(r, delai));
      return route.fulfill(json({ numero, code, codeRecuLe: code ? '2026-10-06T10:00:00.000Z' : null })).catch(() => {});
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

test('🔴 en Pro (lot 6, B2b) : le numéro est inclus, « Obtenir mon numéro » sans jamais « Payer »', async ({ page }) => {
  await mockAccueil(page, { account: SANS_NUMERO, inscription: { complete: {} } });
  const etat = await simulerNumeroFourni(page, { abonnement: null, inclusDansLePro: true });
  await page.goto('/connecter-whatsapp');
  await expect(page.getByTestId('choix-fourni')).toContainText('Inclus dans votre Pro');
  await page.getByTestId('choix-fourni').click();
  await expect(page.getByTestId('numero-inclus')).toBeVisible();
  await expect(page.getByTestId('payer-numero')).toHaveCount(0);
  await page.getByTestId('obtenir-numero').click();
  await expect(page.getByText('+441235619343').first()).toBeVisible();
  expect(etat.gestes).toEqual(['obtenir']);
});

test('🔴 retour de Stripe avant le webhook : « confirmation en cours », et pas de second paiement', async ({ page }) => {
  await mockAccueil(page, { account: SANS_NUMERO, inscription: { complete: {} } });
  const etat = await simulerNumeroFourni(page, { abonnement: null });
  await page.goto('/connecter-whatsapp?abonnement=recu');
  // 🟡 Le parcours s'ouvre de lui-même sur le numéro fourni : le client vient de le payer, il ne le rechoisit pas.
  await expect(page.getByTestId('choix-fourni')).toHaveCount(0);
  await expect(page.getByTestId('paiement-en-confirmation')).toBeVisible();
  await expect(page.getByTestId('payer-numero')).toHaveCount(0);
  // Le webhook passe : l'abonnement est actif et le numéro attribué ; la page le montre sans rien recharger.
  etat.abonnement = 'actif';
  etat.numero = '+441235619343';
  await expect(page.getByTestId('numero-fourni')).toHaveText('+441235619343', { timeout: 12_000 });
  expect(etat.gestes).toEqual([]);
});

test('🟡 retour de Stripe, mais l’abonnement est résilié : « Payer » revient', async ({ page }) => {
  await mockAccueil(page, { account: SANS_NUMERO, inscription: { complete: {} } });
  await simulerNumeroFourni(page, { abonnement: 'resilie' });
  await page.goto('/connecter-whatsapp?abonnement=recu');
  await expect(page.getByTestId('payer-numero')).toBeVisible();
  await expect(page.getByTestId('paiement-en-confirmation')).toHaveCount(0);
});

test('🟡 « Abandonner » pendant que l’abonnement court : un texte qui le dit, pas « en préparation »', async ({ page }) => {
  await mockAccueil(page, { account: SANS_NUMERO, inscription: { complete: {} } });
  const etat = await simulerNumeroFourni(page, { abonnement: 'actif', lecturesAvantCode: 100 });
  etat.numero = '+441235619343';
  await page.goto('/connecter-whatsapp');
  await expect(page.getByTestId('numero-fourni')).toHaveText('+441235619343');
  await page.getByTestId('abandonner-numero').click();
  await page.getByTestId('choix-fourni').click();
  await expect(page.getByTestId('numero-rendu')).toBeVisible();
  await expect(page.getByTestId('numero-en-preparation')).toHaveCount(0);
  await expect(page.getByTestId('gerer-abonnement')).toBeVisible();
  expect(etat.gestes).toEqual(['abandonner']);
});

test('🔴 « Abandonner » qui programme la fin chez Stripe (lot 4, B) : la page dit que l’abonnement prend fin', async ({ page }) => {
  await mockAccueil(page, { account: SANS_NUMERO, inscription: { complete: {} } });
  const etat = await simulerNumeroFourni(page, { abonnement: 'actif', lecturesAvantCode: 100, finProgrammee: true });
  etat.numero = '+441235619343';
  await page.goto('/connecter-whatsapp');
  await expect(page.getByTestId('numero-fourni')).toHaveText('+441235619343');
  await page.getByTestId('abandonner-numero').click();
  await page.getByTestId('choix-fourni').click();
  await expect(page.getByTestId('numero-rendu')).toContainText(/prend fin/);
  await expect(page.getByTestId('numero-rendu')).not.toContainText(/continue/);
});

test('🟡 le portail de Stripe s’ouvre depuis la console', async ({ page }) => {
  await mockAccueil(page, { account: SANS_NUMERO, inscription: { complete: {} } });
  const etat = await simulerNumeroFourni(page, { abonnement: 'actif' });
  await page.goto('/connecter-whatsapp');
  await page.getByTestId('choix-fourni').click();
  await page.getByTestId('gerer-abonnement').click();
  await expect(page).toHaveURL(/portail=ouvert/);
  expect(etat.gestes).toEqual(['portail']);
});

test('🟡 sans abonnement, pas de bouton du portail', async ({ page }) => {
  await mockAccueil(page, { account: SANS_NUMERO, inscription: { complete: {} } });
  await simulerNumeroFourni(page, { abonnement: null });
  await page.goto('/connecter-whatsapp');
  await page.getByTestId('choix-fourni').click();
  await expect(page.getByTestId('payer-numero')).toBeVisible();
  await expect(page.getByTestId('gerer-abonnement')).toHaveCount(0);
});

test('🟡 « Remplacer » : une lecture partie avant ne réaffiche pas l’ancien numéro ni son code', async ({ page }) => {
  await mockAccueil(page, { account: SANS_NUMERO, inscription: { complete: {} } });
  const A = '+441235619343';
  const B = '+442071234567';
  // Les lectures de A sont lentes et portent le code de A ; celles de B, plus lentes encore, n'en ont pas.
  const etat = await simulerNumeroFourni(page, {
    abonnement: 'actif',
    codeDe: (n) => (n === A ? '111111' : null),
    delaiLecture: (n) => (n === A ? 2_500 : 8_000),
  });
  etat.numero = A;
  await page.goto('/connecter-whatsapp');
  await expect(page.getByTestId('numero-fourni')).toHaveText(A, { timeout: 10_000 });
  // Une lecture du code de A part ; « Remplacer » est cliqué pendant qu'elle est en route.
  const lente = page.waitForResponse((r) => r.request().method() === 'GET' && /\/numero-fourni$/.test(new URL(r.url()).pathname), { timeout: 15_000 });
  await page.waitForRequest((r) => r.method() === 'GET' && /\/numero-fourni$/.test(new URL(r.url()).pathname), { timeout: 15_000 });
  await page.getByTestId('remplacer-numero').click();
  await expect(page.getByTestId('numero-fourni')).toHaveText(B);
  await lente;
  await page.waitForTimeout(500);
  await expect(page.getByTestId('numero-fourni')).toHaveText(B);
  await expect(page.getByTestId('code-capte')).not.toContainText('111111');
  await expect(page.getByTestId('code-capte')).toContainText('En attente de l’appel de Meta');
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

test('🟡 espace connecté avec un numéro fourni payé : « Gérer mon abonnement »', async ({ page }) => {
  await mockAccueil(page);
  const etat = await simulerNumeroFourni(page, { abonnement: 'actif' });
  await page.goto('/connecter-whatsapp');
  await expect(page.getByTestId('numero-connecte')).toBeVisible();
  await page.getByTestId('gerer-abonnement').click();
  await expect(page).toHaveURL(/portail=ouvert/);
  expect(etat.gestes).toEqual(['portail']);
});
