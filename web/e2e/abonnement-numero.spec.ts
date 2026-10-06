import { test, expect, type Page } from '@playwright/test';

/**
 * L'ABONNEMENT DU NUMÉRO DANS LA CONSOLE (lot 4, livraison A) : le bandeau qui suit l'état sur chaque page, le
 * réabonnement du MÊME numéro depuis « Connecter WhatsApp », et la page publique où Stripe renvoie après un
 * réabonnement demandé à Claude. Le serveur est simulé.
 */
const TENANT = 'tenant-e2e';
type Etat = { etat: string | null; finPrevueLe: string | null; coupureLe: string | null; liberationLe: string | null; fini: boolean } | 'absent';

async function monter(page: Page, o: { etat: Etat; role?: 'admin' | 'agent'; connecte?: boolean; statut?: string | null; chiffresConnectes?: string }) {
  const gestes: string[] = [];
  await page.addInitScript((s) => { window.localStorage.setItem('mba.session', JSON.stringify(s)); },
    { token: 'e2e-token', email: 'x@e2e.test', role: o.role ?? 'admin', tenantId: TENANT });
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname;
    if (chemin.endsWith('/abonnement-numero')) {
      return o.etat === 'absent' ? route.fulfill(json({ error: 'Not Found' }, 404)) : route.fulfill(json(o.etat));
    }
    if (req.method() === 'POST' && chemin.endsWith('/numero-fourni/portail')) {
      gestes.push('portail');
      return route.fulfill(json({ url: '/compte?portail=ouvert' }));
    }
    if (req.method() === 'POST' && chemin.endsWith('/numero-fourni/abonnement')) {
      gestes.push(`payer:${(req.postDataJSON() as { retour: string }).retour}`);
      return route.fulfill(json({ url: '/compte?abonnement=recu' }));
    }
    if (chemin.includes('/account-status')) {
      return route.fulfill(json(o.connecte
        ? { hasNumber: true, phoneNumberId: 'pn1', number: '+44 1259 797311', status: { dot: 'grey', label: 'x', reason: 'x' } }
        : { hasNumber: false, phoneNumberId: null, number: null, status: { dot: 'grey', label: 'x', reason: 'x' } }));
    }
    if (chemin.endsWith('/connexion-numero')) {
      return route.fulfill(json({
        etat: {
          fourni: '+441259797311', code: null,
          connecte: o.connecte ? { chiffres: o.chiffresConnectes ?? '441259797311', aActiver: false } : null,
          abonnement: o.statut ? { statut: o.statut, periodeFin: null } : null,
        },
        empreinte: '0123456789abcdef',
      }));
    }
    return route.fulfill(json({}));
  });
  return gestes;
}

const SUSPENDU_FINI: Etat = { etat: 'suspendu', finPrevueLe: null, coupureLe: null, liberationLe: '2026-10-13T15:14:51.000Z', fini: true };

test('🔴 suspendu (fini) : le bandeau le dit avec la date de libération, et « Se réabonner » ouvre le paiement', async ({ page }) => {
  const gestes = await monter(page, { etat: SUSPENDU_FINI });
  await page.goto('/compte');
  const b = page.getByTestId('bandeau-abonnement');
  await expect(b).toBeVisible();
  await expect(b).toHaveAttribute('data-etat', 'suspendu');
  await expect(b).toContainText('13');
  await page.getByTestId('bandeau-abonnement-reabonner').click();
  await expect(page).toHaveURL(/abonnement=recu/);
  expect(gestes).toEqual(['payer:console']);
});

test('🔴 en retard : la date de la coupure, et « Régler » ouvre le portail', async ({ page }) => {
  const gestes = await monter(page, { etat: { etat: 'en_retard', finPrevueLe: null, coupureLe: '2026-10-20T10:00:00.000Z', liberationLe: null, fini: false } });
  await page.goto('/compte');
  await expect(page.getByTestId('bandeau-abonnement')).toContainText('20');
  await page.getByTestId('bandeau-abonnement-regler').click();
  await expect(page).toHaveURL(/portail=ouvert/);
  expect(gestes).toEqual(['portail']);
});

test('suspendu faute de paiement : « Régler » (le portail), pas un nouveau paiement', async ({ page }) => {
  await monter(page, { etat: { etat: 'suspendu', finPrevueLe: null, coupureLe: null, liberationLe: null, fini: false } });
  await page.goto('/compte');
  await expect(page.getByTestId('bandeau-abonnement-regler')).toBeVisible();
  await expect(page.getByTestId('bandeau-abonnement-reabonner')).toHaveCount(0);
});

test('🔴 un membre voit le bandeau, sans bouton : il prévient un administrateur', async ({ page }) => {
  await monter(page, { etat: SUSPENDU_FINI, role: 'agent' });
  await page.goto('/compte');
  await expect(page.getByTestId('bandeau-abonnement')).toContainText(/administrateur/);
  await expect(page.getByTestId('bandeau-abonnement-reabonner')).toHaveCount(0);
  await expect(page.getByTestId('bandeau-abonnement-regler')).toHaveCount(0);
});

test('fin prévue : un bandeau discret avec la date ; actif, sans abonnement ou API plus ancienne : aucun bandeau', async ({ page }) => {
  await monter(page, { etat: { etat: 'fin_prevue', finPrevueLe: '2026-11-06T14:51:15.000Z', coupureLe: null, liberationLe: null, fini: false } });
  await page.goto('/compte');
  await expect(page.getByTestId('bandeau-abonnement')).toHaveAttribute('data-etat', 'fin_prevue');
  for (const etat of [{ etat: 'actif', finPrevueLe: null, coupureLe: null, liberationLe: null, fini: false }, { etat: null, finPrevueLe: null, coupureLe: null, liberationLe: null, fini: false }, 'absent'] as Etat[]) {
    const autre = await page.context().newPage();
    await monter(autre, { etat });
    await autre.goto('/compte');
    await expect(autre.getByRole('heading').first()).toBeVisible();
    await expect(autre.getByTestId('bandeau-abonnement')).toHaveCount(0);
    await autre.close();
  }
});

test('🔴 « Connecter WhatsApp », numéro connecté et abonnement résilié : « Se réabonner » au même numéro', async ({ page }) => {
  const gestes = await monter(page, { etat: SUSPENDU_FINI, connecte: true, statut: 'resilie' });
  await page.goto('/connecter-whatsapp');
  await expect(page.getByTestId('numero-connecte')).toBeVisible();
  await page.getByTestId('se-reabonner').click();
  await expect(page).toHaveURL(/abonnement=recu/);
  expect(gestes).toEqual(['payer:console']);
});

test('🔴 « Connecter WhatsApp », le numéro connecté est le SIEN et un vieil abonnement est résilié : pas de « Se réabonner » (jaune 2)', async ({ page }) => {
  await monter(page, { etat: 'absent', connecte: true, statut: 'resilie', chiffresConnectes: '33612345678' });
  await page.goto('/connecter-whatsapp');
  await expect(page.getByTestId('numero-connecte')).toBeVisible();
  await expect(page.getByTestId('se-reabonner')).toHaveCount(0);
});

test('🔴 en retard SANS date de coupure (un autre numéro envoie) : le bandeau ne promet aucune coupure', async ({ page }) => {
  await monter(page, { etat: { etat: 'en_retard', finPrevueLe: null, coupureLe: null, liberationLe: null, fini: false } });
  await page.goto('/compte');
  const b = page.getByTestId('bandeau-abonnement');
  await expect(b).toContainText(/réglez-le pour le garder/);
  await expect(b).not.toContainText(/coupés/);
});

test('la page publique où Stripe renvoie après un réabonnement demandé à Claude, sans session', async ({ page }) => {
  await page.goto('/paiement-recu?abonnement=recu');
  await expect(page.getByTestId('paiement-recu')).toContainText(/Claude/);
  await page.goto('/paiement-recu?abonnement=abandon');
  await expect(page.getByTestId('paiement-abandonne')).toBeVisible();
});
