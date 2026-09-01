import { test, expect } from '@playwright/test';
import { OUTILS_MCP } from '../lib/mcp-outils';

/**
 * L'écran « Serveur MCP », dans Developers.
 *
 * C'est la page d'où part un intégrateur : s'il n'y trouve pas l'adresse et la commande, il n'y a pas
 * d'intégration. Le test vérifie donc le chemin de nav (la page n'est atteignable que par là) et la
 * présence de ce qu'on lui promet, y compris la ligne qui dit ce que le serveur ne fait PAS : c'est celle
 * qui évite qu'il conçoive son agent autour d'un envoi de template qui n'existe pas.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

async function mock(page: import('@playwright/test').Page, cles: unknown[] = [cle(['mcp:read'])]) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.includes('/api-keys')) return json({ keys: cles });
    return json({});
  });
}

/** Une clé telle que la liste la rend. `revokedAt` non nul = elle ne peut plus rien, mais elle RESTE listée. */
const cle = (scopes: string[], revokedAt: string | null = null) => ({
  id: `k-${scopes.join('-')}`, name: 'test', scopes, createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null, revokedAt,
});

test.describe('Developers : le serveur MCP', () => {
  test('🔴 la NAV y mène, et la page donne l adresse et la commande', async ({ page }) => {
    await mock(page);
    await page.goto('/accueil');
    await page.getByRole('button', { name: 'Developers' }).click();
    await page.getByRole('link', { name: 'Serveur MCP' }).click();
    await expect(page).toHaveURL(/\/developers\/mcp/);

    // L'adresse suit l'origine de la console : en test c'est localhost, en production le vrai domaine.
    await expect(page.getByTestId('mcp-adresse')).toContainText('/mcp');
    await expect(page.getByText(/claude mcp add --transport http/)).toBeVisible();
    await expect(page.getByTestId('mcp-copier')).toBeVisible();
  });

  test('🔴 chaque outil du catalogue est annoncé, avec son droit', async ({ page }) => {
    // La liste vient du même module que la page : si un outil est ajouté côté serveur sans être documenté,
    // c'est le test de parité de la racine qui tombe ; ici on vérifie que ce qui est documenté S AFFICHE.
    await mock(page);
    await page.goto('/developers/mcp');
    for (const o of OUTILS_MCP) {
      await expect(page.getByText(o.nom, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('mcp:write').first()).toBeVisible();
  });

  test('🔴 sans clé MCP, la page PRÉVIENT que la commande sera refusée', async ({ page }) => {
    // Copier une commande qui ne peut pas marcher, c'est un aller-retour de support garanti. Une clé qui
    // n'a QUE des droits non-MCP ne compte pas, et une clé MCP RÉVOQUÉE non plus : elle reste dans la liste.
    await mock(page, [cle(['contacts:write']), cle(['mcp:write'], '2026-09-01T10:00:00.000Z')]);
    await page.goto('/developers/mcp');
    await expect(page.getByTestId('mcp-sans-cle')).toBeVisible();
    await page.getByRole('link', { name: /Créer une clé avec/ }).click();
    await expect(page).toHaveURL(/\/developers\/keys/);
  });

  test('🔴 avec une clé MCP vivante, aucun avertissement', async ({ page }) => {
    // L'autre sens : un avertissement qui s'affiche tout le temps ne se lit plus.
    await mock(page, [cle(['mcp:read'])]);
    await page.goto('/developers/mcp');
    await expect(page.getByText(/claude mcp add/)).toBeVisible();
    await expect(page.getByTestId('mcp-sans-cle')).toHaveCount(0);
  });

  test('🔴 la page DIT ce que le serveur ne fait pas', async ({ page }) => {
    // Sans ces phrases, un intégrateur conçoit son agent autour d'un envoi de template, et découvre trop
    // tard qu'il n'existe pas. Les taire coûterait plus cher que de les écrire.
    await mock(page);
    await page.goto('/developers/mcp');
    await expect(page.getByText(/Pas d’envoi de template, pas de campagne/)).toBeVisible();
    await expect(page.getByText(/Hors de la fenêtre de 24 h, rien ne part/)).toBeVisible();
    await expect(page.getByText(/Les automations ne se déclenchent pas/)).toBeVisible();
  });
});
