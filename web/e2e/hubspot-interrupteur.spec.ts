import { test, expect, type Page } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * L'INTERRUPTEUR HUBSPOT DE L'ESPACE (migration 0179, design validé par Julien le 2026-09-25).
 *
 * 🔴 LE DÉFAUT DE DÉPART : sur un espace neuf, SANS numéro WhatsApp, l'Accueil n'offrait aucun bouton pour
 * connecter HubSpot, parce que le bloc ne s'affichait qu'avec un numéro. C'est désormais l'interrupteur de
 * Paramètres > Intégrations qui le fait apparaître. Le serveur tient sa frontière de son côté
 * (`tests/hubspot-interrupteur.test.ts`) ; ici, on regarde ce que l'écran MONTRE et ce qu'il ENVOIE.
 */
const PORTAIL = { connected: true, hubId: '139615673', hubDomain: 'cobaye.hubspot.com', listsScopeGranted: true };
const REGLAGES = { controlHandbackSeconds: null, mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false };
const SANS_NUMERO = { hasNumber: false, phoneNumberId: null, number: null };

test.describe('Accueil : le bloc HubSpot suit l’interrupteur', () => {
  test('🔴 SANS numéro, interrupteur allumé : le bloc et son bouton « Connecter HubSpot » s’affichent', async ({ page }) => {
    await mockAccueil(page, { account: SANS_NUMERO, settings: { ...REGLAGES, hubspotActif: true } });
    await expect(page.getByTestId('hubspot-card')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connecter HubSpot' })).toBeVisible();
    await expect(page.getByTestId('hubspot-tuto-link-cta')).toHaveAttribute('href', '/tuto-hubspot');
    // La synchro se règle par numéro : sans numéro, pas de toggle.
    await expect(page.getByTestId('hubspot-sync-toggle')).toHaveCount(0);
    await expect(page.getByTestId('hubspot-renvoi')).toHaveCount(0);
  });

  test('SANS numéro, interrupteur éteint : pas de bloc, une ligne renvoie vers Paramètres > Intégrations', async ({ page }) => {
    await mockAccueil(page, { account: SANS_NUMERO, settings: { ...REGLAGES, hubspotActif: false } });
    await expect(page.getByTestId('hubspot-renvoi')).toBeVisible();
    await expect(page.getByTestId('hubspot-renvoi-lien')).toHaveAttribute('href', '/parametres#integration-hubspot');
    await expect(page.getByTestId('hubspot-card')).toHaveCount(0);
  });

  test('AVEC numéro, interrupteur éteint, sans portail : pas de bloc non plus, la même ligne', async ({ page }) => {
    await mockAccueil(page, { settings: { ...REGLAGES, hubspotActif: false } });
    await expect(page.getByTestId('hubspot-renvoi')).toBeVisible();
    await expect(page.getByTestId('hubspot-card')).toHaveCount(0);
  });

  test('🔴 champ absent (API plus ancienne) : le comportement d’avant, le bloc suit le numéro', async ({ page }) => {
    await mockAccueil(page, { settings: REGLAGES });
    await expect(page.getByTestId('hubspot-card')).toBeVisible();
    await expect(page.getByTestId('hubspot-renvoi')).toHaveCount(0);
  });

  test('champ absent et sans numéro : ni bloc ni ligne, comme avant', async ({ page }) => {
    await mockAccueil(page, { account: SANS_NUMERO, settings: REGLAGES });
    await expect(page.getByTestId('settings-card')).toBeVisible();
    await expect(page.getByTestId('hubspot-card')).toHaveCount(0);
    await expect(page.getByTestId('hubspot-renvoi')).toHaveCount(0);
  });

  test('🔴 éteint MAIS portail relié : le bloc reste, sinon la déconnexion serait introuvable', async ({ page }) => {
    await mockAccueil(page, { account: { ...SANS_NUMERO, hubspotPortal: PORTAIL }, settings: { ...REGLAGES, hubspotActif: false } });
    await expect(page.getByTestId('hubspot-card')).toBeVisible();
    await expect(page.getByTestId('hubspot-deconnexion-espace')).toBeVisible();
  });

  test('🔴 SANS numéro, portail relié : la déconnexion complète passe par la porte de l’ESPACE', async ({ page }) => {
    const appels: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/hubspot')) appels.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    await mockAccueil(page, { account: { ...SANS_NUMERO, hubspotPortal: PORTAIL }, settings: { ...REGLAGES, hubspotActif: true } });
    await expect(page.getByTestId('hubspot-card')).toContainText('cobaye.hubspot.com');
    await expect(page.getByTestId('hubspot-sync-toggle')).toHaveCount(0);
    await page.getByTestId('hubspot-deconnexion-espace').click();
    const dialogue = page.getByTestId('hubspot-disconnect-dialog');
    await expect(dialogue).toBeVisible();
    // La pause se règle par numéro : sans numéro, elle n'est pas offerte.
    await expect(page.getByTestId('hubspot-pause-btn')).toHaveCount(0);
    await page.getByTestId('hubspot-disconnect-btn').click();
    await expect(page.getByText('HubSpot non connecté')).toBeVisible();
    expect(appels.filter((a) => a.endsWith('/hubspot/deconnexion'))).toEqual(['POST /api/backend/tenants/t-e2e/hubspot/deconnexion']);
    expect(appels.some((a) => a.includes('/phone-numbers/')), 'aucun numéro inventé dans l’adresse').toBe(false);
  });
});

interface Trace { patchs: Array<Record<string, unknown>> }

/** Monte Paramètres (admin) avec des réglages et un statut de compte donnés. `refus` : le PATCH rend 409. */
async function parametres(page: Page, o: { reglages: Record<string, unknown>; compte?: Record<string, unknown>; refus?: string }): Promise<Trace> {
  const trace: Trace = { patchs: [] };
  const session = { token: 'e2e-token', email: 'moi@e2e.test', role: 'admin', tenantId: 't-e2e' };
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), session);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = req.url().split('?')[0]!;
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/settings/hubspot-actif') && req.method() === 'PATCH') {
      const corps = req.postDataJSON() as Record<string, unknown>;
      trace.patchs.push(corps);
      if (o.refus) return json({ error: o.refus }, 409);
      return json({ hubspotActif: corps.actif });
    }
    if (chemin.endsWith('/settings/agents-peuvent-prendre')) return json({ actif: false });
    if (chemin.endsWith('/settings')) return json({ mbaEnabled: false, timezone: 'Europe/Paris', businessHours: {}, ...o.reglages });
    if (chemin.endsWith('/account-status')) return json(o.compte ?? { hasNumber: false, hubspotPortal: { connected: false } });
    if (chemin.endsWith('/integrations/batch')) return json({ branche: false });
    if (chemin.endsWith('/contacts/blocked')) return json({ contacts: [] });
    if (chemin.endsWith('/unread-count')) return json({ count: 0 });
    if (chemin.endsWith('/me')) return json({ email: 'moi@e2e.test', name: 'Moi', role: 'admin' });
    return json({});
  });
  await page.goto('/parametres');
  return trace;
}

test.describe('Paramètres > Intégrations > HubSpot', () => {
  test('🔴 éteint, non relié : on l’allume, l’écran envoie `actif: true` et propose la connexion', async ({ page }) => {
    const trace = await parametres(page, { reglages: { hubspotActif: false, hubspotPortalConnecte: false } });
    const carte = page.getByTestId('integration-hubspot');
    const bouton = page.getByTestId('integration-hubspot-toggle');
    await expect(carte).toBeVisible();
    await expect(page.getByTestId('integration-hubspot-etat')).toContainText('Éteint');
    await expect(page.getByTestId('integration-hubspot-portail')).toContainText('Aucun portail HubSpot relié');
    await expect(bouton).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('integration-hubspot-connecter')).toHaveCount(0);
    await bouton.click();
    await expect.poll(() => trace.patchs.length, { timeout: 10_000 }).toBe(1);
    expect(trace.patchs[0]).toEqual({ actif: true });
    await expect(bouton).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('integration-hubspot-connecter')).toBeVisible();
    await expect(page.getByTestId('integration-hubspot-tuto')).toHaveAttribute('href', '/tuto-hubspot');
  });

  test('🔴 allumé et relié : l’interrupteur est grisé, la raison est dite, le portail est nommé', async ({ page }) => {
    const trace = await parametres(page, {
      reglages: { hubspotActif: true, hubspotPortalConnecte: true },
      compte: { hasNumber: false, hubspotPortal: PORTAIL },
    });
    const bouton = page.getByTestId('integration-hubspot-toggle');
    await expect(bouton).toBeDisabled();
    await expect(page.getByTestId('integration-hubspot-raison')).toContainText('Déconnexion complète');
    await expect(page.getByTestId('integration-hubspot-portail')).toContainText('cobaye.hubspot.com');
    await expect(page.getByTestId('integration-hubspot-connecter')).toHaveCount(0);
    expect(trace.patchs).toEqual([]);
  });

  test('🔴 le serveur refuse (409) : son message s’affiche, et l’interrupteur revient à sa place', async ({ page }) => {
    const message = 'Un portail HubSpot est relié à cet espace : faites d’abord la « Déconnexion complète » depuis l’Accueil, puis éteignez HubSpot.';
    const trace = await parametres(page, { reglages: { hubspotActif: true, hubspotPortalConnecte: false }, refus: message });
    const bouton = page.getByTestId('integration-hubspot-toggle');
    await expect(bouton).toHaveAttribute('aria-pressed', 'true');
    await bouton.click();
    await expect(page.getByTestId('integration-hubspot-erreur')).toContainText('Déconnexion complète');
    await expect(bouton).toHaveAttribute('aria-pressed', 'true');
    expect(trace.patchs).toEqual([{ actif: false }]);
  });

  test('champ absent (API plus ancienne) : pas d’interrupteur, l’écran le dit', async ({ page }) => {
    await parametres(page, { reglages: {} });
    await expect(page.getByTestId('integration-hubspot-etat')).toContainText('indisponible');
    await expect(page.getByTestId('integration-hubspot-toggle')).toHaveCount(0);
  });
});
