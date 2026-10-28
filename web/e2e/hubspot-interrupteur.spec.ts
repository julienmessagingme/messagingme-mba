import { test, expect, type Page } from './aide/test';
import { mockAccueil } from './support/accueil';

/**
 * L'INTERRUPTEUR HUBSPOT DE L'ESPACE (migration 0179, design validé par Julien le 2026-09-25).
 *
 * 🔴 LE DÉFAUT DE DÉPART : sur un espace neuf, SANS numéro WhatsApp, l'Accueil n'offrait aucun bouton pour
 * connecter HubSpot, parce que le bloc ne s'affichait qu'avec un numéro. C'est désormais l'interrupteur de
 * Tools > Intégrations qui le fait apparaître. Le serveur tient sa frontière de son côté
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

  test('SANS numéro, interrupteur éteint : pas de bloc, une ligne renvoie vers Tools > Intégrations', async ({ page }) => {
    await mockAccueil(page, { account: SANS_NUMERO, settings: { ...REGLAGES, hubspotActif: false } });
    await expect(page.getByTestId('hubspot-renvoi')).toBeVisible();
    await expect(page.getByTestId('hubspot-renvoi-lien')).toHaveAttribute('href', '/integrations#integration-hubspot');
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

interface Trace { puts: Array<Record<string, unknown>> }

/**
 * Monte Paramètres (admin) avec des réglages et un statut de compte donnés (lot 1bis : le choix des fonctions).
 * `refus` : le PUT du choix rend ce statut avec ce message.
 */
async function parametres(page: Page, o: { reglages: Record<string, unknown>; compte?: Record<string, unknown>; refus?: { status: number; error: string }; offre?: Record<string, unknown> }): Promise<Trace> {
  const trace: Trace = { puts: [] };
  const session = { token: 'e2e-token', email: 'moi@e2e.test', role: 'admin', tenantId: 't-e2e' };
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), session);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = req.url().split('?')[0]!;
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/hubspot/choix') && req.method() === 'PUT') {
      const corps = req.postDataJSON() as Record<string, unknown>;
      trace.puts.push(corps);
      if (o.refus) return json({ error: o.refus.error }, o.refus.status);
      return json({
        hubspotAnalyse: corps.analyse, hubspotPassage: corps.passage, hubspotInjoignable: corps.injoignable,
        hubspotReponse: corps.reponse, hubspotModeles: corps.reponse === true && corps.modeles === true, hubspotWorkflows: corps.workflows === true, hubspotListsEnabled: corps.listes, hubspotChoixValideLe: '2026-10-23T18:00:00.000Z',
        routingMode: corps.taches === undefined ? null : corps.taches ? 'mm_routing' : 'hubspot_native',
        tachesAppliquees: true, premiereValidation: true,
      });
    }
    if (chemin.endsWith('/offre') && o.offre) return json(o.offre);
    if (chemin.endsWith('/settings/agents-peuvent-prendre')) return json({ actif: false });
    if (chemin.endsWith('/settings')) return json({ mbaEnabled: false, timezone: 'Europe/Paris', businessHours: {}, ...o.reglages });
    if (chemin.endsWith('/account-status')) return json(o.compte ?? { hasNumber: false, hubspotPortal: { connected: false } });
    if (chemin.endsWith('/integrations/batch')) return json({ branche: false });
    if (chemin.endsWith('/contacts/blocked')) return json({ contacts: [] });
    if (chemin.endsWith('/unread-count')) return json({ count: 0 });
    if (chemin.endsWith('/me')) return json({ email: 'moi@e2e.test', name: 'Moi', role: 'admin' });
    return json({});
  });
  await page.goto('/integrations');
  return trace;
}

const CHOIX_FAIT = { hubspotPortalConnecte: true, hubspotAnalyse: true, hubspotPassage: true, hubspotInjoignable: true, hubspotReponse: false, hubspotListsEnabled: false, hubspotChoixValideLe: '2026-10-20T10:00:00.000Z' };

test.describe('Tools > Intégrations > HubSpot : le choix des fonctions (lot 1bis)', () => {
  test('rien de relié : « Connecter HubSpot » et le tuto, pas de choix', async ({ page }) => {
    await parametres(page, { reglages: { hubspotPortalConnecte: false } });
    await expect(page.getByTestId('integration-hubspot-etat')).toContainText('Aucun portail HubSpot relié');
    await expect(page.getByTestId('integration-hubspot-connecter')).toBeVisible();
    await expect(page.getByTestId('integration-hubspot-tuto')).toHaveAttribute('href', '/tuto-hubspot');
    await expect(page.getByTestId('integration-hubspot-analyse-toggle')).toHaveCount(0);
  });

  test('🔴 relié, jamais choisi : l’étape de choix, défauts cochés, et « Valider » envoie le choix avec le mode connu', async ({ page }) => {
    const trace = await parametres(page, {
      reglages: { ...CHOIX_FAIT, hubspotChoixValideLe: null },
      compte: { hasNumber: false, hubspotPortal: { ...PORTAIL, routingMode: 'mm_routing' } },
    });
    await expect(page.getByTestId('integration-hubspot-etape-choix')).toBeVisible();
    await expect(page.getByTestId('integration-hubspot-etat')).toContainText('cobaye.hubspot.com');
    await expect(page.getByTestId('integration-hubspot-analyse-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('integration-hubspot-listes-toggle')).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('integration-hubspot-valider').click();
    await expect.poll(() => trace.puts.length, { timeout: 10_000 }).toBe(1);
    expect(trace.puts[0]).toEqual({ analyse: true, passage: true, injoignable: true, reponse: false, modeles: false, workflows: false, listes: false, taches: true });
    await expect(page.getByTestId('integration-hubspot-etape-choix')).toHaveCount(0);
  });

  test('🔴 mode des tâches INCONNU (lecture du portail en échec) : la ligne est grisée et une bascule ne l’envoie jamais', async ({ page }) => {
    const trace = await parametres(page, { reglages: CHOIX_FAIT, compte: { hasNumber: false, hubspotPortal: { connected: false } } });
    await expect(page.getByTestId('integration-hubspot-taches-toggle')).toBeDisabled();
    await page.getByTestId('integration-hubspot-injoignable-toggle').click();
    await expect.poll(() => trace.puts.length, { timeout: 10_000 }).toBe(1);
    expect(trace.puts[0]).toEqual({ analyse: true, passage: true, injoignable: false, reponse: false, modeles: false, workflows: false, listes: false });
  });

  test('le serveur refuse : son message s’affiche, et l’interrupteur revient à sa place', async ({ page }) => {
    const message = 'Votre offre ne comprend pas l’import de listes. Passez en Entreprise.';
    const trace = await parametres(page, {
      reglages: CHOIX_FAIT,
      compte: { hasNumber: false, hubspotPortal: { ...PORTAIL, routingMode: 'mm_routing' } },
      refus: { status: 402, error: message },
    });
    const listes = page.getByTestId('integration-hubspot-listes-toggle');
    await expect(listes).toHaveAttribute('aria-pressed', 'false');
    await listes.click();
    await expect(page.getByTestId('integration-hubspot-erreur')).toContainText('offre');
    await expect(listes).toHaveAttribute('aria-pressed', 'false');
    expect(trace.puts).toHaveLength(1);
  });
});

// La grille du serveur, réduite à ce que l'écran lit : la réponse vient avec l'Inbox (Pro), l'analyse et les listes avec
// Entreprise (`console-free.spec.ts` porte la grille complète).
const limites = { utilisateurs: null, admins: null, contacts: null, envoisModelesMois: null, automations: null, suppressionsJour: null, adressesWebhook: 5, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 10, badge: false, numeroInclus: true };
const GRILLE = {
  free: { fonctions: ['aide'], limites },
  pro: { fonctions: ['inbox', 'console'], limites },
  entreprise: { fonctions: ['inbox', 'console', 'analyse', 'crm'], limites },
};
const offre = (o: 'pro' | 'entreprise', fonctions = GRILLE[o].fonctions) => ({
  offre: o, fonctions, limites, usage: { envoisModelesMois: 0, contacts: 0, automations: 0, membres: 1 }, grille: GRILLE,
  upgradeUrl: 'https://console.e2e.test/offre',
});

test.describe('Paramètres > Intégrations > HubSpot : « Répondre aux clients depuis HubSpot » (lot 3)', () => {
  test('🔴 en Pro : la ligne est ouverte et s’allume, l’analyse dit l’offre qui l’ouvre (Entreprise)', async ({ page }) => {
    const trace = await parametres(page, {
      reglages: CHOIX_FAIT,
      compte: { hasNumber: false, hubspotPortal: { ...PORTAIL, routingMode: 'mm_routing' } },
      offre: offre('pro'),
    });
    const reponse = page.getByTestId('integration-hubspot-reponse-toggle');
    await expect(page.getByTestId('integration-hubspot-reponse')).toContainText('Jamais à un contact qui a dit STOP');
    await expect(reponse).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('integration-hubspot-analyse-offre')).toHaveText('Inclus dans l’offre Entreprise.');
    await expect(page.getByTestId('integration-hubspot-reponse-offre')).toHaveCount(0);
    await reponse.click();
    await expect.poll(() => trace.puts.length, { timeout: 10_000 }).toBe(1);
    expect(trace.puts[0]).toMatchObject({ reponse: true });
    await expect(reponse).toHaveAttribute('aria-pressed', 'true');
  });

  test('🔴 une offre sans l’Inbox : la ligne se lit éteinte, ne s’allume pas, et dit « Inclus dans l’offre Pro »', async ({ page }) => {
    const trace = await parametres(page, {
      reglages: { ...CHOIX_FAIT, hubspotReponse: true },
      compte: { hasNumber: false, hubspotPortal: { ...PORTAIL, routingMode: 'mm_routing' } },
      offre: offre('pro', ['console']),
    });
    const reponse = page.getByTestId('integration-hubspot-reponse-toggle');
    await expect(page.getByTestId('integration-hubspot-reponse-offre')).toHaveText('Inclus dans l’offre Pro.');
    await expect(reponse).toHaveAttribute('aria-pressed', 'false');
    await expect(reponse).toBeDisabled();
    expect(trace.puts).toHaveLength(0);
  });
});

test.describe('Paramètres > Intégrations > HubSpot : « Envoyer des modèles depuis HubSpot » (sous-lot « relancer »)', () => {
  test('🔴 réponse éteinte : la ligne est grisée et le dit ; allumée, elle s’allume ; éteindre la réponse l’éteint', async ({ page }) => {
    const trace = await parametres(page, {
      reglages: CHOIX_FAIT,
      compte: { hasNumber: false, hubspotPortal: { ...PORTAIL, routingMode: 'mm_routing' } },
      offre: offre('pro'),
    });
    const modeles = page.getByTestId('integration-hubspot-modeles-toggle');
    const reponse = page.getByTestId('integration-hubspot-reponse-toggle');
    await expect(modeles).toBeDisabled();
    await expect(page.getByTestId('integration-hubspot-modeles-sans-reponse')).toBeVisible();
    await reponse.click();
    await expect.poll(() => trace.puts.length, { timeout: 10_000 }).toBe(1);
    await expect(modeles).toBeEnabled();
    await modeles.click();
    await expect.poll(() => trace.puts.length, { timeout: 10_000 }).toBe(2);
    expect(trace.puts[1]).toMatchObject({ reponse: true, modeles: true });
    await expect(modeles).toHaveAttribute('aria-pressed', 'true');
    await reponse.click();
    await expect.poll(() => trace.puts.length, { timeout: 10_000 }).toBe(3);
    expect(trace.puts[2]).toMatchObject({ reponse: false, modeles: false });
    await expect(modeles).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('Paramètres > Intégrations > HubSpot : « Workflows HubSpot : envoyer des modèles WhatsApp » (action de workflow)', () => {
  test('🔴 éteint par défaut, s’allume et part dans le choix, sans dépendre de la réponse', async ({ page }) => {
    const trace = await parametres(page, {
      reglages: CHOIX_FAIT,
      compte: { hasNumber: false, hubspotPortal: { ...PORTAIL, routingMode: 'mm_routing' } },
      offre: offre('entreprise'),
    });
    const workflows = page.getByTestId('integration-hubspot-workflows-toggle');
    await expect(workflows).toHaveAttribute('aria-pressed', 'false');
    await expect(workflows).toBeEnabled();
    await workflows.click();
    await expect.poll(() => trace.puts.length, { timeout: 10_000 }).toBe(1);
    expect(trace.puts[0]).toMatchObject({ reponse: false, workflows: true });
    await expect(workflows).toHaveAttribute('aria-pressed', 'true');
  });

  test('🔴 une offre sans HubSpot : la ligne ne s’allume pas et dit quelle offre l’ouvre', async ({ page }) => {
    const trace = await parametres(page, {
      reglages: CHOIX_FAIT,
      compte: { hasNumber: false, hubspotPortal: { ...PORTAIL, routingMode: 'mm_routing' } },
      offre: offre('pro'),
    });
    await expect(page.getByTestId('integration-hubspot-workflows-toggle')).toBeDisabled();
    await expect(page.getByTestId('integration-hubspot-workflows-offre')).toBeVisible();
    expect(trace.puts).toHaveLength(0);
  });
});
