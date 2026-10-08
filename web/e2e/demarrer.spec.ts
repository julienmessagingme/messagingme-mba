import { test, expect, type Page } from '@playwright/test';
import { mockAccueil } from './support/accueil';
import { API_PUBLIQUE, commandeMcp } from '../lib/demarrer';

/**
 * LE TUNNEL DE LA BASE (lot 19, plan `docs/superpowers/plans/2026-10-08-tunnel-de-la-base.md`) : après l'inscription, la
 * page du numéro (sautable), puis la page finale qui donne tout pour vivre dans Claude Code.
 */
const SANS_NUMERO = { hasNumber: false, phoneNumberId: null, number: null, numberStatus: null, codeVerificationStatus: null, status: { dot: 'grey', label: 'Aucun numéro', reason: 'Aucun numéro connecté.' } };

/** La création de la clé : le serveur la rend une seule fois. Garde ce que la page a demandé. */
async function simulerCreationCle(page: Page) {
  const demandes: Array<{ name: string; scopes: string[] }> = [];
  await page.route('**/api/backend/tenants/*/api-keys', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const corps = route.request().postDataJSON() as { name: string; scopes: string[] };
    demandes.push(corps);
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'k1', key: 'mm_live_e2e', name: corps.name, scopes: corps.scopes }) });
  });
  return demandes;
}

test('🔴 sans numéro : « Plus tard » mène à la page finale, qui propose de le brancher', async ({ page }) => {
  await mockAccueil(page, { account: SANS_NUMERO, inscription: { complete: {} } });
  await page.goto('/connecter-whatsapp?suite=demarrer');
  await page.getByTestId('numero-plus-tard').click();
  await page.waitForURL('**/demarrer');
  await expect(page.getByTestId('demarrer-connecter-numero')).toHaveAttribute('href', '/connecter-whatsapp?suite=demarrer');
  await expect(page.getByTestId('demarrer-prompt')).toContainText('start_whatsapp_connection');
});

test('🔴 la commande branche Claude Code SANS clé (connexion OAuth au premier usage)', async ({ page }) => {
  await mockAccueil(page);
  await page.goto('/demarrer');
  const commande = page.getByTestId('demarrer-commande');
  // Ce serveur de test a une `BASE` relative, comme l'ancienne console du VPS : l'adresse reste celle de l'API, seul
  // hôte où la connexion OAuth s'annonce, jamais le domaine de la page.
  await expect(commande).toHaveText(commandeMcp(API_PUBLIQUE));
  await expect(commande).toContainText('claude mcp add --transport http messagingme ');
  await expect(commande).not.toContainText(/Authorization|Bearer|VOTRE_CLE/);
});

test('🔴 la clé de l’application : créée avec les droits par défaut et la lecture des fils, montrée une fois en ligne de .env', async ({ page }) => {
  await mockAccueil(page);
  const demandes = await simulerCreationCle(page);
  await page.goto('/demarrer');
  await page.getByTestId('demarrer-creer-cle').click();
  await expect(page.getByTestId('demarrer-cle')).toHaveText('MESSAGINGME_API_KEY=mm_live_e2e');
  await expect(page.getByTestId('demarrer-creer-cle')).toHaveCount(0);
  expect(demandes).toHaveLength(1);
  // Plus la lecture des fils (lot 13) : l'application répond aux messages, et répondre demande le contexte.
  expect(demandes[0]!.scopes).toEqual(['contacts:write', 'sends:create', 'conversations:read']);
  // Le prompt range la clé dans la variable, jamais dans le code.
  await expect(page.getByTestId('demarrer-prompt')).toContainText('MESSAGINGME_API_KEY');
});

test('numéro connecté : « Continuer » mène à la page finale, qui l’affiche et ne propose plus de le brancher', async ({ page }) => {
  await mockAccueil(page);
  await page.goto('/connecter-whatsapp?suite=demarrer');
  await page.getByTestId('numero-continuer').click();
  await page.waitForURL('**/demarrer');
  await expect(page.getByTestId('demarrer-numero')).toContainText('+33 5 25 68 02 50');
  await expect(page.getByTestId('demarrer-connecter-numero')).toHaveCount(0);
  await expect(page.getByTestId('demarrer-prompt')).not.toContainText('start_whatsapp_connection');
});

test('🟡 la suite survit au retour de Stripe, et s’efface une fois la page finale atteinte', async ({ page }) => {
  await mockAccueil(page, { account: SANS_NUMERO, inscription: { complete: {} } });
  await page.goto('/connecter-whatsapp?suite=demarrer');
  await expect(page.getByTestId('numero-plus-tard')).toBeVisible();
  // Le retour de paiement d'un numéro fourni arrive sans la suite (`src/stripe/abonnement.ts`).
  await page.goto('/connecter-whatsapp?abonnement=recu');
  await page.getByTestId('numero-plus-tard').click();
  await page.waitForURL('**/demarrer');
  await expect(page.getByTestId('demarrer-commande')).toBeVisible();
  await page.goto('/connecter-whatsapp');
  await expect(page.getByTestId('choix-fourni')).toBeVisible();
  await expect(page.getByTestId('numero-plus-tard')).toHaveCount(0);
});
