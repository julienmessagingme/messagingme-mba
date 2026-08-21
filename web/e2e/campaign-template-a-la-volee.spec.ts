import { test, expect } from '@playwright/test';

/**
 * Créer un template SANS quitter la campagne : ce que l'écran doit faire pendant la revue Meta.
 *
 * Vécu à corriger : le panneau annonçait « statut : PENDING » puis ne bougeait plus. Le bouton « Rafraîchir
 * la liste » rechargeait bien les templates, mais filtrés sur APPROVED et pour le SÉLECTEUR fermé au-dessus.
 * Le panneau, lui, affichait un statut figé à la création. On croyait le bouton cassé, alors que Meta avait
 * déjà approuvé entre-temps : il fallait fermer le panneau pour s'en apercevoir.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

/** Un SECOND template, déjà approuvé, disponible dans le sélecteur pendant l'attente. */
const AUTRE = {
  id: 'T2', name: 'relance_juin', status: 'APPROVED', category: 'MARKETING', language: 'fr',
  body: 'Une relance', headerFormat: null, isCarousel: false, editable: true,
};

const TPL = (status: string) => ({
  id: 'T1', name: 'testurl', status, category: 'MARKETING', language: 'fr',
  body: 'Bonjour', headerFormat: null, isCarousel: false, editable: true,
});

/**
 * Faux backend dont le statut du template ÉVOLUE : au bout de `approuveApres` lectures, Meta a approuvé.
 * Sans cette évolution, aucun test ne pourrait distinguer « l'écran redemande » de « l'écran n'a rien fait ».
 */
async function mock(page: import('@playwright/test').Page, approuveApres: number) {
  const etat = { lectures: 0 };
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });

    if (url.includes('/templates')) {
      if (method === 'POST') return json({ id: 'T1', status: 'PENDING' }, 201);
      etat.lectures += 1;
      return json({ templates: [TPL(etat.lectures > approuveApres ? 'APPROVED' : 'PENDING'), AUTRE] });
    }
    if (url.includes('/template-params')) return json({ hints: [] });
    if (url.includes('/contacts/count')) return json({ total: 0 });
    if (url.includes('/contacts')) return json({ contacts: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.includes('/campaign-drafts')) return json({ drafts: [] });
    if (url.includes('/campaigns')) return json({ campaigns: [] });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33525680250', verifiedName: 'Auxerre Mobilité' }] });
    if (url.endsWith('/workflows')) return json({ workflows: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
  return etat;
}

/** Ouvre la création de campagne et soumet un template à la volée. */
async function soumettreUnTemplate(page: import('@playwright/test').Page) {
  await page.goto('/campaigns');
  await page.getByRole('button', { name: /Ajouter une campagne/i }).click();
  // La zone du template reste inerte tant que la campagne n'a pas de nom (étape 1 de l'écran).
  await page.getByTestId('campaign-name').fill('Campagne de test');
  await page.getByTestId('campaign-name').blur();
  await page.getByRole('button', { name: /Créer un nouveau template/ }).click();
  await page.getByPlaceholder('promo_ete').fill('testurl');
  // Le corps est un contentEditable (il porte des jetons de variable), pas un <textarea> : on tape dedans.
  const corps = page.getByRole('textbox', { name: /Corps du message|Message body/ });
  await corps.click();
  await corps.pressSequentially('Bonjour, voici notre offre');
  await page.getByRole('button', { name: /^Créer le template$/ }).click();
  await expect(page.getByTestId('template-soumis')).toBeVisible();
}

test.describe('Campagne : template créé à la volée', () => {
  test('🔴 « Vérifier maintenant » RAPPORTE l’approbation à l’écran', async ({ page }) => {
    // Le coeur du défaut : le panneau restait sur le statut figé à la création.
    await mock(page, 1);
    await soumettreUnTemplate(page);
    await expect(page.getByTestId('template-soumis')).toContainText('PENDING');

    await page.getByTestId('verifier-statut').click();
    await expect(page.getByTestId('template-soumis')).toContainText(/approuvé par Meta|approved by Meta/);
  });

  test('🔴 une fois approuvé, le template est SÉLECTIONNÉ tout seul pour la campagne', async ({ page }) => {
    await mock(page, 1);
    await soumettreUnTemplate(page);
    await page.getByTestId('verifier-statut').click();
    // Le sélecteur porte le template : l'opérateur n'a pas à le rechoisir à la main.
    await expect(page.locator('select').filter({ hasText: 'testurl' })).toHaveValue('testurl');
  });

  test('🔴 l’écran vérifie TOUT SEUL, sans le moindre clic', async ({ page }) => {
    // C'est la demande de fond : ne pas laisser le client devant un bouton qu'il faut penser à cliquer.
    // Le sondage bat toutes les 15 s, d'où la patience explicite.
    test.setTimeout(90_000);
    await mock(page, 1);
    await soumettreUnTemplate(page);
    await expect(page.getByTestId('template-soumis')).toContainText('PENDING');
    await expect(page.getByTestId('template-soumis')).toContainText(/approuvé par Meta|approved by Meta/, { timeout: 45_000 });
  });

  test('🔴 un choix fait PENDANT l’attente n’est jamais écrasé, et la phrase ne ment pas', async ({ page }) => {
    // Le garde-fou existait, mais le panneau annonçait « il est sélectionné » sans savoir si quoi que ce soit
    // l'avait été. L'opérateur lançait sur cette assurance, avec l'AUTRE template.
    await mock(page, 1);
    await soumettreUnTemplate(page);
    // Il choisit un autre template pendant la revue.
    await page.locator('select').filter({ hasText: 'relance_juin' }).selectOption('relance_juin');
    await page.getByTestId('verifier-statut').click();
    await expect(page.getByTestId('template-soumis')).toContainText(/approuvé par Meta|approved by Meta/);
    // Son choix tient...
    await expect(page.locator('select').filter({ hasText: 'relance_juin' })).toHaveValue('relance_juin');
    // ... et l'écran le DIT, au lieu d'affirmer une sélection qui n'a pas eu lieu.
    await expect(page.getByTestId('template-soumis')).toContainText(/Choisissez-le dans la liste|Pick it from the list/);
    await expect(page.getByTestId('template-soumis')).not.toContainText(/Il est sélectionné|It is selected/);
  });

  test('🔴 le sondage S’ARRÊTE sur un statut terminal', async ({ page }) => {
    // Sans condition d'arrêt, on continuerait d'appeler Meta toutes les 15 s pour rien, sur un panneau que
    // l'opérateur peut laisser ouvert des heures.
    test.setTimeout(90_000);
    const etat = await mock(page, 1);
    await soumettreUnTemplate(page);
    await page.getByTestId('verifier-statut').click();
    await expect(page.getByTestId('template-soumis')).toContainText(/approuvé par Meta|approved by Meta/);
    const apresApprobation = etat.lectures;
    // Deux battements complets plus tard, aucune lecture de plus que la relecture unique du statut terminal.
    await page.waitForTimeout(35_000);
    expect(etat.lectures - apresApprobation).toBeLessThanOrEqual(1);
  });

  test('🔴 un refus est annoncé comme tel, et n’invente pas le motif', async ({ page }) => {
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const method = route.request().method();
      const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/templates')) {
        if (method === 'POST') return json({ id: 'T1', status: 'PENDING' }, 201);
        return json({ templates: [TPL('REJECTED'), AUTRE] });
      }
      if (url.includes('/template-params')) return json({ hints: [] });
      if (url.includes('/contacts/count')) return json({ total: 0 });
      if (url.includes('/contacts')) return json({ contacts: [] });
      if (url.includes('/unread-count')) return json({ count: 0 });
      if (url.includes('/campaign-drafts')) return json({ drafts: [] });
      if (url.includes('/campaigns')) return json({ campaigns: [] });
      if (url.includes('/phone-numbers')) return json({ phoneNumbers: [] });
      if (url.endsWith('/workflows')) return json({ workflows: [] });
      if (url.includes('/user-fields')) return json({ fields: [] });
      if (url.includes('/tags')) return json({ tags: [] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await soumettreUnTemplate(page);
    await page.getByTestId('verifier-statut').click();
    await expect(page.getByTestId('template-soumis')).toContainText(/refusé par Meta|rejected by Meta/);
    // Le motif n'est pas dans la liste des templates : l'écran renvoie là où Meta l'affiche, sans le deviner.
    await expect(page.getByTestId('template-soumis')).toContainText(/écran Templates|Templates screen/);
    // Et il n'y a plus de bouton de vérification : le statut est terminal.
    await expect(page.getByTestId('verifier-statut')).toHaveCount(0);
  });
});
