import { test, expect, type Page } from '@playwright/test';
import { CODES_DOCUMENTES } from '../lib/api-exemples';
import { EVENEMENTS_SIGNAUX } from '../lib/signaux-dictionnaire';
import { PAGES_DOC, pageDoc, type CleDePage } from '../lib/doc-api-pages';
import { LOCALE_STORAGE_KEY } from '../lib/locale';

/**
 * La documentation de l'API, RENDUE, page par page (refonte du 2026-09-25).
 *
 * La suite racine (`tests/api-exemples.test.ts`) vérifie la SOURCE des fichiers de la doc : exemples validés,
 * aucun JSON écrit à la main, aucun outil tiers nommé. Ici, on vérifie ce qu'un intégrateur VOIT, sur CHAQUE
 * page de la carte (`lib/doc-api-pages.ts`, la page MCP comprise) : dans la console, sans compte, en anglais,
 * sur mobile, un seul `h1`, ses sections, et toujours aucun outil tiers dans le texte affiché.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

async function avecSession(page: Page) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.includes('/api-keys')) return json({ keys: [] });
    return json({});
  });
}

/** Aucune session : c'est l'intégrateur qui arrive de la vitrine, sans compte. */
async function sansSession(page: Page) {
  await page.route('**/api/backend/**', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
}

/** Les titres de section que chaque page doit montrer (en plus de son `h1`, tiré de la carte). */
const SECTIONS: Record<CleDePage, string[]> = {
  accueil: ['Adresse de base', 'Authentification', 'Premier appel'],
  contacts: ['POST /v1/contacts', 'POST /v1/contacts/batch', 'GET /v1/contacts/{contactId}', 'POST /v1/contacts/search', 'PATCH /v1/contacts/{contactId}'],
  messages: ['Messages simples', 'POST /v1/messages/whatsapp', 'POST /v1/messages/rcs', 'POST /v1/sends', 'GET /v1/sends/{sendId}'],
  catalogs: ['GET /v1/templates', 'GET /v1/scenarios', 'GET /v1/rcs-messages'],
  concepts: ['Désigner une personne', 'Consentement et STOP', 'La fenêtre de 24 h', 'Idempotence'],
  'per-contact': ['1 L’adresse et l’en-tête', '3 La clé d’idempotence', '6 Éprouver l’appel'],
  events: ['Ce que nous remontons', 'Délais', 'Les événements', 'Les attributs de la fiche'],
  reference: ['Authentification et droits', 'Débit', 'Erreurs'],
  mcp: ['Adresse', 'Ce que l’assistant peut faire', 'Ce qu’il ne fait pas'],
};

/**
 * Les commandes complètes : elles vivaient toutes à la fin de l'ancienne page (« Exemples complets ») et sont
 * désormais posées à côté de leur route. Le compte par page garde qu'aucune ne s'est perdue au déplacement.
 */
const COMMANDES: Partial<Record<CleDePage, number>> = { accueil: 1, messages: 4, 'per-contact': 1 };

const OUTILS_TIERS = /custom_id|Universal Channel|Brevo|Salesforce|SFMC|Splio|HubSpot|Klaviyo|Braze|Zapier|smsmode|uchat/i;

test.describe('Developers : la documentation de l’API, page par page', () => {
  for (const p of PAGES_DOC) {
    test(`🔴 ${p.href} : dans la console, un seul h1, ses sections, ses ancres, aucun outil tiers`, async ({ page }) => {
      await avecSession(page);
      await page.goto(p.href);
      await expect(page.getByTestId('onglets')).toBeVisible();
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('h1')).toHaveText(p.titre[0]);
      await expect(page).toHaveURL(new RegExp(`${p.href.replace(/\//g, '\\/')}$`));
      const doc = page.getByTestId('doc-api');
      for (const titre of SECTIONS[p.cle]) await expect(doc.getByRole('heading', { name: titre, exact: true })).toBeVisible();
      for (const ancre of p.ancres) await expect(page.locator(`[id="${ancre}"]`), `ancre #${ancre}`).toHaveCount(1);
      await expect(page.getByTestId('nav-doc').getByRole('link', { name: p.nav[0], exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(doc.locator('pre', { hasText: 'curl -X POST' })).toHaveCount(COMMANDES[p.cle] ?? 0);
      // ⚠️ Le CONTENU de la page, pas `body` : la barre latérale de la console nomme d'autres écrans (une
      // intégration CRM y a sa page), ce qui ferait échouer ce cas pour une raison étrangère à la doc.
      const texte = await doc.innerText();
      expect(texte).not.toMatch(/(?<![/\w])batch(?!\w)/i);
      expect(texte).not.toMatch(OUTILS_TIERS);
    });

    test(`🔴 ${p.href} : sans session, la page est PUBLIQUE (pas de renvoi au login)`, async ({ page }) => {
      await sansSession(page);
      await page.goto(p.href);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('h1')).toHaveText(p.titre[0]);
      await expect(page).toHaveURL(new RegExp(`${p.href.replace(/\//g, '\\/')}$`));
      await expect(page.getByRole('link', { name: 'Se connecter' })).toBeVisible();
      await expect(page.getByTestId('onglets')).toHaveCount(0);
    });

    test(`${p.href} : en anglais`, async ({ page }) => {
      await page.addInitScript((cle) => window.localStorage.setItem(cle, 'en'), LOCALE_STORAGE_KEY);
      await sansSession(page);
      await page.goto(p.href);
      await expect(page.locator('h1')).toHaveText(p.titre[1]);
      await expect(page.getByTestId('nav-doc').getByRole('link', { name: p.nav[1], exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    });

    test(`🔴 ${p.href} : sur mobile, aucun débordement horizontal, dans la console comme sans compte`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      for (const connecte of [false, true]) {
        if (connecte) await avecSession(page); else await sansSession(page);
        await page.goto(p.href);
        await expect(page.locator('h1')).toHaveText(p.titre[0]);
        await expect(page.getByTestId('nav-doc')).toBeHidden();
        await expect(page.getByTestId('nav-doc-mobile')).toBeVisible();
        const deborde = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(deborde, connecte ? 'dans la console' : 'sans compte').toBeLessThanOrEqual(0);
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      }
    });
  }

  test('🔴 la navigation mène à chaque page, et marque la page courante', async ({ page }) => {
    await avecSession(page);
    await page.goto(pageDoc('accueil').href);
    for (const p of PAGES_DOC) {
      await page.getByTestId('nav-doc').getByRole('link', { name: p.nav[0], exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${p.href.replace(/\//g, '\\/')}$`));
      await expect(page.locator('h1')).toHaveText(p.titre[0]);
      await expect(page.getByTestId('nav-doc').getByRole('link', { name: p.nav[0], exact: true })).toHaveAttribute('aria-current', 'page');
    }
  });

  test('🔴 sur mobile, le bouton « Documentation » pousse le contenu au lieu de le recouvrir, et mène aux pages', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await sansSession(page);
    await page.goto(pageDoc('contacts').href);
    const menu = page.getByTestId('nav-doc-mobile');
    await menu.locator('summary').click();
    const lien = menu.getByRole('link', { name: pageDoc('concepts').nav[0], exact: true });
    await expect(lien).toBeVisible();
    const boiteMenu = await menu.boundingBox();
    const boiteDoc = await page.getByTestId('doc-api').boundingBox();
    expect(boiteDoc!.y).toBeGreaterThanOrEqual(boiteMenu!.y + boiteMenu!.height);
    await lien.click();
    await expect(page).toHaveURL(/\/developers\/api\/concepts$/);
    await expect(page.locator('h1')).toHaveText(pageDoc('concepts').titre[0]);
  });

  test('🔴 chaque code d’erreur est au catalogue de la Référence, chaque événement sur la page Événements', async ({ page }) => {
    await avecSession(page);
    await page.goto(pageDoc('reference').href);
    for (const c of CODES_DOCUMENTES) await expect(page.getByTestId('doc-api').getByTestId(`code-${c.code}`)).toBeVisible();
    await page.goto(pageDoc('events').href);
    for (const e of EVENEMENTS_SIGNAUX) await expect(page.getByTestId('doc-api').getByTestId(`signal-${e.nom}`)).toBeVisible();
  });

  test('un lien vers une ancre d’une autre page y mène, et la montre', async ({ page }) => {
    await sansSession(page);
    await page.goto(`${pageDoc('concepts').href}#idempotence`);
    await expect(page.locator('#idempotence')).toBeInViewport();
  });

  test.describe('le bouton Copier', () => {
    test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
    test('copie exactement le bloc qu’il accompagne (l’adresse de base)', async ({ page }) => {
      await sansSession(page);
      await page.goto(pageDoc('accueil').href);
      const bloc = page.locator('#adresse').locator('pre');
      await page.locator('#adresse').getByTestId('copier').click();
      await expect(page.locator('#adresse').getByTestId('copier')).toHaveText('Copié');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await bloc.innerText());
      expect(await bloc.innerText()).toMatch(/^https?:\/\/.+\/v1$/);
    });
  });
});
