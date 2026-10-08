import { test, expect, type Page } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * DÉVELOPPEURS > WEBHOOKS SORTANTS (lot 12, livraison A) : créer une adresse (le secret montré une seule fois), l'essai,
 * le journal, et la limite d'adresses de l'offre. Le serveur est simulé.
 */
const TYPES = ['message.received', 'message.delivered', 'message.read', 'message.failed', 'link.clicked', 'contact.opted_out', 'conversation.analyzed', 'contact.risk_changed'];
const PAR_DEFAUT = TYPES.filter((t) => !['message.delivered', 'message.read', 'message.failed'].includes(t));
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

async function simuler(page: Page, o: { limite?: number | null } = {}) {
  const etat = { adresses: [] as Array<Record<string, unknown>>, corpsCreation: null as unknown, essais: 0, lecturesJournal: 0 };
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/backend/tenants/*/evenements/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname;
    if (req.method() === 'GET' && chemin.endsWith('/evenements/adresses')) {
      return route.fulfill(json({ adresses: etat.adresses, limite: o.limite === undefined ? null : o.limite, types: TYPES, typesParDefaut: PAR_DEFAUT, chiffrementPret: true }));
    }
    if (req.method() === 'POST' && chemin.endsWith('/evenements/adresses')) {
      etat.corpsCreation = req.postDataJSON();
      const c = etat.corpsCreation as { url: string; types: string[] };
      const adresse = {
        id: 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f', url: c.url, description: '', types: c.types, active: true, creeLe: '2026-10-08T10:00:00.000Z',
        ancienSecretJusqua: null, derniereLivraisonLe: null, enReessai: 0, echecs: 0,
      };
      etat.adresses.push(adresse);
      return route.fulfill(json({ adresse, secret: SECRET }, 201));
    }
    if (req.method() === 'POST' && chemin.endsWith('/essai')) {
      etat.essais += 1;
      return route.fulfill(json({ evenementId: 'evt_1', livre: true, code: 200, reponse: 'ok' }));
    }
    if (req.method() === 'GET' && chemin.endsWith('/envois')) {
      etat.lecturesJournal += 1;
      return route.fulfill(json({ envois: [{
        id: 'e1', evenementId: 'evt_1', type: 'test', statut: 'livre', tentatives: 1, dernierCode: 200, derniereReponse: 'ok',
        prochainEssaiLe: null, creeLe: '2026-10-08T10:01:00.000Z', livreLe: '2026-10-08T10:01:00.000Z', corps: '{"id":"evt_1","type":"test"}',
      }] }));
    }
    return route.fulfill(json({}));
  });
  return etat;
}

test('🔴 créer une adresse : les accusés décochés par défaut, puis le secret montré une seule fois', async ({ page }) => {
  await mockAccueil(page);
  const etat = await simuler(page);
  await page.goto('/developers/evenements');
  await expect(page.getByTestId('evt-type-message.received')).toBeChecked();
  await expect(page.getByTestId('evt-type-message.delivered')).not.toBeChecked();
  await page.getByTestId('evt-url').fill('https://app.client.fr/hook');
  await page.getByTestId('evt-creer').click();
  await expect(page.getByTestId('evt-secret')).toHaveText(SECRET);
  expect(etat.corpsCreation).toMatchObject({ url: 'https://app.client.fr/hook', types: PAR_DEFAUT });
  await page.getByRole('button', { name: /J’ai copié le secret|I copied the secret/ }).click();
  await expect(page.getByTestId('evt-secret')).toHaveCount(0);
  await expect(page.getByTestId('evt-adresse')).toContainText('https://app.client.fr/hook');
});

test('l’essai dit ce que l’application a répondu, et le journal montre l’envoi', async ({ page }) => {
  await mockAccueil(page);
  const etat = await simuler(page);
  etat.adresses.push({
    id: 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f', url: 'https://app.client.fr/hook', description: '', types: PAR_DEFAUT, active: true,
    creeLe: '2026-10-08T10:00:00.000Z', ancienSecretJusqua: null, derniereLivraisonLe: null, enReessai: 0, echecs: 0,
  });
  await page.goto('/developers/evenements');
  await page.getByTestId('evt-essai').click();
  await expect(page.getByTestId('evt-essai-issue')).toContainText('200');
  await page.getByTestId('evt-journal').click();
  await expect(page.getByTestId('evt-envoi')).toHaveCount(1);
  // 🔴 Le journal se lit UNE fois : il a tourné en boucle (chaque lecture rechargeait la page, qui relançait la
  // lecture), assez pour faire répondre 429 à toute la console de l'admin en moins d'une minute.
  await page.waitForTimeout(1500);
  expect(etat.lecturesJournal).toBe(1);
});

test('🔴 en Base, une adresse active atteint la limite : la création est fermée et l’offre est proposée', async ({ page }) => {
  await mockAccueil(page);
  const etat = await simuler(page, { limite: 1 });
  etat.adresses.push({
    id: 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f', url: 'https://app.client.fr/hook', description: '', types: PAR_DEFAUT, active: true,
    creeLe: '2026-10-08T10:00:00.000Z', ancienSecretJusqua: null, derniereLivraisonLe: null, enReessai: 0, echecs: 0,
  });
  await page.goto('/developers/evenements');
  await expect(page.getByTestId('evt-limite')).toBeVisible();
  await page.getByTestId('evt-url').fill('https://autre.client.fr/hook');
  await expect(page.getByTestId('evt-creer')).toBeDisabled();
});
