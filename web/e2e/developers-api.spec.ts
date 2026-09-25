import { test, expect, type Page } from '@playwright/test';
import { CODES_DOCUMENTES } from '../lib/api-exemples';
import { EVENEMENTS_SIGNAUX } from '../lib/signaux-dictionnaire';
import { ANCRES_DEPLACEES, PAGES_DOC, hrefDe, pageDoc, type CleDePage, type LienVers } from '../lib/doc-api-pages';
import { ENDPOINTS } from '../lib/api-doc-endpoints';
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

/**
 * Les titres de section que chaque page doit montrer (en plus de son `h1`, tiré de la carte). Les routes s'y
 * ajoutent d'elles-mêmes : chaque endpoint de l'index (`lib/api-doc-endpoints.ts`) a son titre sur SA page.
 */
const SECTIONS: Record<CleDePage, string[]> = {
  accueil: ['Premier appel', 'Tous les endpoints', 'Adresse de base', 'Authentification'],
  contacts: [],
  messages: ['Message ou envoi'],
  sends: ['Types de cible', 'Destinataires', 'Paramètres et variables', 'Message d’ouverture', 'Catégorie', 'Exemples de cibles'],
  catalogs: [],
  concepts: ['Désigner une personne', 'Consentement et STOP', 'La fenêtre de 24 h', 'Idempotence'],
  'per-contact': ['1 L’adresse et l’en-tête', '3 La clé d’idempotence', '6 Éprouver l’appel'],
  events: ['Ce que la console remonte', 'Délais', 'Les événements', 'Les attributs de la fiche'],
  reference: ['Authentification et droits', 'Débit', 'Erreurs'],
  mcp: ['Adresse', 'Ce que l’assistant peut faire', 'Ce qu’il ne fait pas'],
};
const titresDe = (cle: CleDePage): string[] => [
  ...SECTIONS[cle],
  ...ENDPOINTS.filter((e) => e.lien.page === cle).map((e) => `${e.methode} ${e.chemin}`),
];

/**
 * Les commandes `curl` complètes, par page : une par route (plus le premier appel, les exemples de cibles et le
 * guide). Le compte EXACT garde qu'aucune ne se perd et qu'aucune ne s'ajoute sans qu'on le voie.
 */
const COMMANDES: Partial<Record<CleDePage, number>> = { accueil: 1, contacts: 5, messages: 2, sends: 3, catalogs: 3, 'per-contact': 1 };

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
      for (const titre of titresDe(p.cle)) await expect(doc.getByRole('heading', { name: titre, exact: true })).toBeVisible();
      for (const ancre of p.ancres) await expect(page.locator(`[id="${ancre}"]`), `ancre #${ancre}`).toHaveCount(1);
      await expect(page.getByTestId('nav-doc').getByRole('link', { name: p.nav[0], exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(doc.locator('pre', { hasText: /^curl / })).toHaveCount(COMMANDES[p.cle] ?? 0);
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

  test('une ancre mal encodée ne fait pas planter la page', async ({ page }) => {
    await sansSession(page);
    await page.goto(`${pageDoc('accueil').href}#%E0%A4%A`);
    await expect(page.locator('h1')).toHaveText(pageDoc('accueil').titre[0]);
  });

  test('🔴 l’index de l’accueil liste les douze endpoints, et chaque lien mène à sa route', async ({ page }) => {
    await sansSession(page);
    await page.goto(`${pageDoc('accueil').href}#endpoints`);
    const index = page.getByTestId('index-endpoints');
    await expect(index.getByRole('link')).toHaveCount(ENDPOINTS.length);
    for (const e of ENDPOINTS) {
      await expect(index.getByRole('link', { name: e.chemin, exact: true }).and(page.locator(`[href="${hrefDe(e.lien)}"]`))).toHaveCount(1);
    }
    // Un clic de l'index mène à la route, et la montre.
    const dernier = ENDPOINTS[ENDPOINTS.length - 1]!;
    await index.locator(`[href="${hrefDe(dernier.lien)}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${pageDoc(dernier.lien.page).href}#${dernier.lien.ancre}$`));
    await expect(page.locator(`[id="${dernier.lien.ancre}"]`)).toBeInViewport();
  });

  test('🔴 chaque route est à l’ancre que l’index annonce, et « Sur cette page » liste celles de sa page', async ({ page }) => {
    await sansSession(page);
    for (const cle of [...new Set(ENDPOINTS.map((e) => e.lien.page))]) {
      await page.goto(pageDoc(cle).href);
      const ici = ENDPOINTS.filter((e) => e.lien.page === cle);
      await expect(page.getByTestId('sur-cette-page').getByRole('link')).toHaveCount(ici.length);
      for (const e of ici) {
        await expect(page.locator(`[id="${e.lien.ancre}"]`).getByRole('heading', { name: `${e.methode} ${e.chemin}`, exact: true })).toBeVisible();
      }
    }
  });

  test('la navigation mène à l’index des endpoints', async ({ page }) => {
    await sansSession(page);
    await page.goto(pageDoc('contacts').href);
    await page.getByTestId('nav-doc').getByRole('link', { name: 'Endpoints', exact: true }).click();
    await expect(page).toHaveURL(/\/developers\/api#endpoints$/);
    await expect(page.locator('#endpoints')).toBeInViewport();
  });

  /**
   * 🔴 LES ANCRES QUI ONT DÉMÉNAGÉ (`ANCRES_DEPLACEES`) : celles de l'ancienne page unique sur l'accueil, celles des
   * envois sur la page Messages. Un favori vers l'une d'elles mène à sa nouvelle adresse, pas en haut de la page.
   */
  for (const [depart, table] of Object.entries(ANCRES_DEPLACEES) as Array<[CleDePage, Record<string, LienVers>]>) {
    for (const [ancre, lien] of Object.entries(table)) {
      test(`${pageDoc(depart).href}#${ancre} mène à ${hrefDe(lien)}`, async ({ page }) => {
        await sansSession(page);
        await page.goto(`${pageDoc(depart).href}#${ancre}`);
        await expect(page).toHaveURL(new RegExp(`${hrefDe(lien).replace(/\//g, '\\/')}$`));
        await expect(page.locator('h1')).toHaveText(pageDoc(lien.page).titre[0]);
      });
    }
  }

  test.describe('le bouton Copier', () => {
    test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
    test('copie exactement le bloc qu’il accompagne (l’adresse de base)', async ({ page }) => {
      await sansSession(page);
      await page.goto(pageDoc('accueil').href);
      const bloc = page.locator('#adresse').locator('pre');
      // Le bouton dit QUEL bloc il copie, et la confirmation est annoncée aux lecteurs d'écran.
      await expect(page.locator('#adresse').getByTestId('copier')).toHaveAttribute('aria-label', 'Copier : Adresse de base');
      await page.locator('#adresse').getByTestId('copier').click();
      await expect(page.locator('#adresse').getByTestId('copier')).toHaveText('Copié');
      await expect(page.locator('#adresse [aria-live="polite"]')).toHaveText('Copié');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await bloc.innerText());
      expect(await bloc.innerText()).toMatch(/^https?:\/\/.+\/v1$/);
    });
  });
});
