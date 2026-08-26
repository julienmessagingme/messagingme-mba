import { test, expect } from '@playwright/test';

/**
 * Campagne AU FIL DE L'EAU : au lieu d'une liste figée, on désigne une adresse (Tools > Webhooks) et la
 * campagne prend chaque contact qui arrive par elle.
 *
 * Deux choses se vérifient ici, et seul un test de bout en bout peut les voir :
 *  - « Autre » ne montre HubSpot que si le connecteur est activé sur l'accueil (demande de Julien du
 *    2026-08-26 : un bouton grisé pour une intégration qu'on n'a pas est du bruit) ;
 *  - une campagne peut devenir lançable SANS aucun contact coché, ce qui était impossible jusqu'ici : c'est
 *    l'adresse qui désigne les destinataires.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const WEBHOOKS = [
  { id: 'wh1', name: 'Leads du site', enabled: true, code: 'ab12cd34ef56gh78jk90mn12pq', url: 'https://x/w/ab', hasSecret: false, mapping: [], createContact: true, optIn: true, workflowId: null, startNodeId: null, cooldownSeconds: null, lastPayload: null, lastReceivedAt: null, contactsCreated: 0, createdAt: '2026-08-20T09:00:00.000Z' },
  { id: 'wh2', name: 'Salon (sans consentement)', enabled: true, code: 'cd12cd34ef56gh78jk90mn12pq', url: 'https://x/w/cd', hasSecret: false, mapping: [], createContact: false, optIn: false, workflowId: null, startNodeId: null, cooldownSeconds: null, lastPayload: null, lastReceivedAt: null, contactsCreated: 0, createdAt: '2026-08-20T09:00:00.000Z' },
  { id: 'wh3', name: 'Adresse éteinte', enabled: false, code: 'ef12cd34ef56gh78jk90mn12pq', url: 'https://x/w/ef', hasSecret: false, mapping: [], createContact: true, optIn: true, workflowId: null, startNodeId: null, cooldownSeconds: null, lastPayload: null, lastReceivedAt: null, contactsCreated: 0, createdAt: '2026-08-20T09:00:00.000Z' },
];

interface Options {
  hubspot?: boolean;
  /** HubSpot activé mais synchronisation EN PAUSE : le bouton existe, mais n'est pas cliquable. */
  hubspotPaused?: boolean;
  creations?: Array<Record<string, unknown>>;
  /** Brouillon de composition à reprendre à l'ouverture de l'écran. */
  brouillon?: Record<string, unknown>;
}

async function monter(page: import('@playwright/test').Page, o: Options = {}) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && /\/campaigns$/.test(url)) {
      o.creations?.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
      // Une campagne au fil de l'eau naît SANS destinataire : c'est bien 0 que rend le serveur.
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ campaignId: 'camp-1', recipientCount: 0, skipped: [] }) });
    }
    if (url.includes('/webhooks')) return json({ webhooks: WEBHOOKS });
    if (url.includes('/contacts/count')) return json({ total: 0 });
    if (url.includes('/contacts')) return json({ contacts: [] });
    if (url.includes('/template-params')) return json({ hints: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.includes('/campaign-drafts')) return json({ drafts: o.brouillon ? [{ id: 'd1', name: 'Repris', state: o.brouillon, updatedAt: '2026-08-26T09:00:00.000Z' }] : [] });
    if (url.includes('/campaigns')) return json({ campaigns: [] });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33525680250', verifiedName: 'Demo' }] });
    if (url.includes('/templates')) return json({ templates: [{ name: 'promo', language: 'fr', status: 'APPROVED', category: 'marketing', body: 'Bonjour' }] });
    if (url.endsWith('/workflows')) return json({ workflows: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: o.hubspot === true, campaignsPaused: o.hubspotPaused === true, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
  await page.goto('/campaigns');
  // Reprise d'un brouillon : on passe par la section « Brouillons » de la liste, pas par « Ajouter ».
  if (o.brouillon) {
    await page.getByTestId('campaign-drafts').getByRole('button', { name: /Reprendre/ }).click();
    return;
  }
  await page.getByRole('button', { name: /Ajouter une campagne/i }).click();
  await page.getByTestId('campaign-name').fill('Leads en continu');
}

test.describe('Campagne : source « Autre »', () => {
  test('🔴 HubSpot n’apparaît PAS quand le connecteur est éteint sur l’accueil', async ({ page }) => {
    await monter(page, { hubspot: false });
    await page.getByTestId('campaign-source-autre').click();
    await expect(page.getByTestId('campaign-source-autre-panel')).toBeVisible();
    await expect(page.getByTestId('campaign-source-hubspot')).toHaveCount(0);
    // Webhook, lui, est toujours là : c'est la source qui rend « Autre » utile même sans HubSpot.
    await expect(page.getByTestId('campaign-source-webhook')).toBeVisible();
  });

  test('HubSpot apparaît quand le connecteur est activé', async ({ page }) => {
    await monter(page, { hubspot: true });
    await page.getByTestId('campaign-source-autre').click();
    await expect(page.getByTestId('campaign-source-hubspot')).toBeVisible();
  });

  test('les deux sources courantes restent en première ligne', async ({ page }) => {
    await monter(page);
    await expect(page.getByRole('button', { name: /Liste de contacts/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Import fichier/ })).toBeVisible();
    // Rien ne s'ouvre tant qu'on n'a pas cliqué « Autre » : la ligne secondaire ne s'impose à personne.
    await expect(page.getByTestId('campaign-source-autre-panel')).toHaveCount(0);
  });
});

test.describe('Campagne au fil de l’eau', () => {
  test('🔴 une adresse suffit à rendre la campagne lançable, SANS aucun contact coché', async ({ page }) => {
    const creations: Array<Record<string, unknown>> = [];
    await monter(page, { creations });
    await page.getByTestId('campaign-source-autre').click();
    await page.getByTestId('campaign-source-webhook').click();

    // Étape 2 fermée tant qu'aucune adresse n'est choisie : l'adresse EST la désignation des destinataires.
    await expect(page.getByText(/Complète l'étape 1/)).toBeVisible();

    await page.getByTestId('campaign-webhook-select').selectOption('wh1');
    await page.locator('select').filter({ has: page.locator('option', { hasText: 'Choisir un template' }) }).selectOption('promo');

    await expect(page.getByText(/Prêt à ouvrir sur « Leads du site »/)).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    await expect.poll(() => creations.length, { timeout: 10_000 }).toBe(1);
    expect(creations[0]).toMatchObject({ webhookId: 'wh1' });
    // Aucune liste envoyée avec l'adresse : le serveur refuserait les deux, et surtout ça mentirait sur ce
    // qui va partir.
    expect(creations[0]!.contactIds).toBeUndefined();
  });

  test('🔴 zéro destinataire à la création n’est PAS une erreur ici', async ({ page }) => {
    // Sur une liste, 0 destinataire est l'alerte rouge « rien ne partira ». Au fil de l'eau, c'est l'état
    // normal de départ : confondre les deux bloquerait la seule création valide.
    const creations: Array<Record<string, unknown>> = [];
    await monter(page, { creations });
    await page.getByTestId('campaign-source-autre').click();
    await page.getByTestId('campaign-source-webhook').click();
    await page.getByTestId('campaign-webhook-select').selectOption('wh1');
    await page.locator('select').filter({ has: page.locator('option', { hasText: 'Choisir un template' }) }).selectOption('promo');
    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    // La création aboutit (le formulaire rend la main à la liste), et SURTOUT l'avertissement rouge
    // « Aucun destinataire » n'apparaît pas : c'est lui qui bloquait ce cas.
    await expect.poll(() => creations.length, { timeout: 15_000 }).toBe(1);
    await expect(page.getByText(/Aucun destinataire/)).toHaveCount(0);
  });

  test('🔴 une adresse qui n’affirme pas le consentement est signalée AVANT le lancement', async ({ page }) => {
    // Sinon la campagne marketing part, écarte tout le monde pour « pas de consentement », et l'opérateur
    // découvre le problème après coup dans le détail des destinataires.
    await monter(page);
    await page.getByTestId('campaign-source-autre').click();
    await page.getByTestId('campaign-source-webhook').click();
    await page.getByTestId('campaign-webhook-select').selectOption('wh2');
    await expect(page.getByTestId('campaign-webhook-optin')).toBeVisible();
    // Et la même adresse ne crée pas les contacts inconnus : deuxième limite, dite elle aussi.
    await expect(page.getByTestId('campaign-webhook-creation')).toBeVisible();

    // L'adresse qui affirme le consentement, elle, ne déclenche aucun avertissement.
    await page.getByTestId('campaign-webhook-select').selectOption('wh1');
    await expect(page.getByTestId('campaign-webhook-optin')).toHaveCount(0);
  });

  test('une adresse DÉSACTIVÉE n’est pas proposée', async ({ page }) => {
    await monter(page);
    await page.getByTestId('campaign-source-autre').click();
    await page.getByTestId('campaign-source-webhook').click();
    const select = page.getByTestId('campaign-webhook-select');
    await expect(select.locator('option', { hasText: 'Leads du site' })).toHaveCount(1);
    await expect(select.locator('option', { hasText: 'Adresse éteinte' })).toHaveCount(0);
  });

  test('revenir sur la liste de contacts oublie l’adresse choisie', async ({ page }) => {
    // Sans ça, une campagne partirait « au fil de l'eau » alors que l'opérateur a sous les yeux une liste.
    const creations: Array<Record<string, unknown>> = [];
    await monter(page, { creations });
    await page.getByTestId('campaign-source-autre').click();
    await page.getByTestId('campaign-source-webhook').click();
    await page.getByTestId('campaign-webhook-select').selectOption('wh1');
    await page.getByRole('button', { name: /Liste de contacts/ }).click();
    await page.getByTestId('campaign-source-autre').click();
    await page.getByTestId('campaign-source-webhook').click();
    await expect(page.getByTestId('campaign-webhook-select')).toHaveValue('');
  });
});

test.describe('Campagne au fil de l’eau : reprises et cas limites', () => {
  test('🔴 un brouillon dont l’adresse a disparu ne part pas sur une adresse morte', async ({ page }) => {
    // Le sélecteur l'afficherait VIDE alors que l'état la porte encore : l'écran aurait l'air prêt, et le
    // serveur refuserait la création en 400 sans que personne comprenne pourquoi.
    // Le brouillon est COMPLET par ailleurs (nom + template) : seule l'adresse manque. C'est ce qui rend
    // l'assertion discriminante, un brouillon incomplet garderait l'étape 2 fermée de toute façon.
    await monter(page, { brouillon: { source: 'webhook', webhookId: 'wh-supprime', mode: 'template', templateName: 'promo', templateLanguage: 'fr', vars: [], phoneNumberId: 'pn1' } });
    await expect(page.getByTestId('campaign-webhook-select')).toBeVisible({ timeout: 15_000 });
    // L'étape 2 reste FERMÉE : sans ce nettoyage, elle s'ouvrirait sur « Prêt à ouvrir sur « » », avec un nom
    // d'adresse vide, et la création partirait vers un 400 serveur incompréhensible.
    await expect(page.getByText(/Complète l'étape 1/)).toBeVisible();
    await expect(page.getByText(/Prêt à ouvrir/)).toHaveCount(0);
  });

  test('un brouillon dont l’adresse existe TOUJOURS la retrouve', async ({ page }) => {
    await monter(page, { brouillon: { source: 'webhook', webhookId: 'wh1', mode: 'template', templateName: 'promo', templateLanguage: 'fr', vars: [], phoneNumberId: 'pn1' } });
    await expect(page.getByTestId('campaign-webhook-select')).toHaveValue('wh1', { timeout: 15_000 });
    await expect(page.getByText(/Prêt à ouvrir sur « Leads du site »/)).toBeVisible();
  });

  test('🔴 HubSpot en PAUSE : « Autre » ouvre sur le webhook, pas sur un panneau inutilisable', async ({ page }) => {
    await monter(page, { hubspot: true, hubspotPaused: true });
    await page.getByTestId('campaign-source-autre').click();
    // Le bouton HubSpot reste visible (le connecteur existe) mais désactivé, et c'est le webhook qui s'ouvre.
    await expect(page.getByTestId('campaign-source-hubspot')).toBeDisabled();
    await expect(page.getByTestId('campaign-webhook-select')).toBeVisible({ timeout: 15_000 });
  });
});
