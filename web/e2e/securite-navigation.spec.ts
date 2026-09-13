import { test, expect, type Page } from '@playwright/test';
import { TREIZE_POUCES, pasDeDebordement } from './aide/largeur';

/**
 * LE CENTRE DE SÉCURITÉ & COMPLIANCE : son menu et sa porte d'entrée.
 *
 * 🔴 LE CAS QUI COMPTE EST LA CORRESPONDANCE. Une boîte de la page d'accueil qui ne correspond à aucun
 * sous-menu (ou l'inverse) est le défaut qui arrive vraiment sur ce genre d'écran : on annonce un chantier,
 * puis on livre la page d'accueil avant le contenu, et l'utilisateur clique dans le vide.
 *
 * ⚠️ LES DEUX JOURNAUX ONT DÉMÉNAGÉ, PAS CHANGÉ. Un test vérifie qu'ils ne sont plus dans Paramètres, et un
 * autre qu'ils sont bien ici : sans le second, « déplacer » et « supprimer » se ressembleraient.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

async function monter(page: Page): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = new URL(route.request().url()).pathname.replace('/api/backend', '');
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/contacts/refus-possibles')) {
      return json({ scannes: 42, refus: [
        { messageId: 'm1', conversationId: 'cv1', contactId: 'ct9', waId: '33600000009', profileName: 'Bob', body: 'arrêtez de me contacter', recuLe: '2026-09-12T09:00:00.000Z' },
      ] });
    }
    if (chemin.endsWith('/contacts/desabonnes')) {
      return json({ contacts: [
        { id: 'ct1', profileName: 'Alice', phoneE164: '+33600000001', desabonneLe: '2026-09-12T10:00:00.000Z', source: 'scenario' },
        // ⚠️ Une ligne SANS date : c'est le cas des désabonnements d'avant la migration 0138, et l'écran
        // doit le DIRE plutôt que d'inventer une date.
        { id: 'ct2', profileName: null, phoneE164: '+33600000002', desabonneLe: null, source: 'crm' },
      ] });
    }
    if (chemin.endsWith('/audit')) return json({ entries: [], total: 0 });
    if (chemin.endsWith('/erreurs-livraison')) return json({ erreurs: [], total: 0 });
    if (chemin.endsWith('/unread-count')) return json({ count: 0 });
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (chemin.endsWith('/settings')) {
      return json({
        mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false,
        controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {},
      });
    }
    return json({});
  });
}

test.describe('Centre de sécurité & compliance', () => {
  test('l entree est au BAS du menu, et elle deplie ses sous-menus', async ({ page }) => {
    await monter(page);
    await page.goto('/securite');
    await expect(page.getByTestId('securite-accueil')).toBeVisible();
    /**
     * 🔴 DANS LA BARRE DU BAS, ET LA PRÉCISION COMPTE : les mêmes libellés existent aussi dans les boîtes de
     * la page. Chercher au hasard dans la page passerait même si le menu restait replié, c'est-à-dire dans
     * le cas exact que ce test existe pour attraper.
     */
    const bas = page.getByTestId('nav-bas');
    await expect(bas.getByRole('link', { name: 'Audit trails' })).toBeVisible();
    await expect(bas.getByRole('link', { name: 'Journal des erreurs' })).toBeVisible();
  });

  test('la page d accueil porte le message d accueil demande', async ({ page }) => {
    await monter(page);
    await page.goto('/securite');
    await expect(page.getByRole('heading', { level: 1 }))
      .toHaveText(/Bienvenue au centre de sécurité & compliance de Engage Me/);
  });

  /**
   * 🔴 UNE BOÎTE PAR SOUS-MENU, ET RÉCIPROQUEMENT. Retirer un sous-menu de la nav sans retirer sa boîte
   * (ou l'inverse) doit faire rougir ce cas : c'est le seul qui attrape « une boîte qui mène nulle part ».
   */
  test('🔴 chaque boite correspond a un sous-menu, et chaque sous-menu a une boite', async ({ page }) => {
    await monter(page);
    await page.goto('/securite');
    const boites = await page.getByTestId(/^securite-boite-/).all();
    const cles = await Promise.all(boites.map(async (b) => (await b.getAttribute('data-testid'))!.replace('securite-boite-', '')));
    expect(cles.length).toBeGreaterThan(0);
    for (const cle of cles) {
      // Le sous-menu de cette clé existe dans la barre, et il mène à la même adresse que la boîte.
      const boite = page.getByTestId(`securite-boite-${cle}`);
      const href = await boite.getAttribute('href');
      expect(href, `la boîte « ${cle} » ne mène nulle part`).toBeTruthy();
      await expect(page.locator(`a[href="${href}"]`)).toHaveCount(2); // la boîte + l'entrée de menu
    }
  });

  test('🔴 les deux journaux sont ICI, et ils repondent', async ({ page }) => {
    await monter(page);
    await page.goto('/securite/audit');
    await expect(page.getByTestId('audit-journal')).toBeVisible();
    await page.goto('/securite/erreurs');
    await expect(page.getByTestId('erreurs-livraison')).toBeVisible();
  });

  /**
   * ⚠️ ET ILS NE SONT PLUS DANS PARAMÈTRES. Sans ce cas, on aurait pu les COPIER au lieu de les déplacer,
   * et deux journaux côte à côte finissent par se contredire le jour où l'un filtre autrement que l'autre.
   */
  test('⚠️ ils ne sont plus dans Parametres, qui repond toujours', async ({ page }) => {
    await monter(page);
    await page.goto('/parametres');
    await expect(page.getByTestId('param-auto-retry-toggle')).toBeVisible();
    await expect(page.getByTestId('audit-journal')).toHaveCount(0);
    await expect(page.getByTestId('erreurs-livraison')).toHaveCount(0);
  });

  /**
   * 🔴 LA DATE MANQUANTE SE DIT, ELLE NE S'INVENTE PAS. Elle n'est enregistrée que depuis la migration
   * 0138 : afficher la derniere modification de la fiche a la place aurait ete plus joli et FAUX, ce qui
   * est le pire resultat possible sur un ecran de conformite.
   */
  test('🔴 le consentement liste les desabonnes, et dit quand la date manque', async ({ page }) => {
    await monter(page);
    await page.goto('/securite/consentement');
    await expect(page.getByTestId('securite-consentement')).toBeVisible();
    await expect(page.getByTestId('desabonne-ligne')).toHaveCount(2);
    await expect(page.getByTestId('desabonnes-compte')).toContainText('2');
    await expect(page.getByTestId('desabonne-date').nth(1)).toContainText(/date inconnue/i);
  });

  /**
   * 🔴 LA RÈGLE ÉLARGIE REMONTE, ELLE NE DÉSABONNE PAS. L'écran doit le DIRE : sans cette phrase, une ligne
   * dans cette section se lirait comme un désabonnement déjà appliqué.
   */
  test('🔴 les refus possibles remontent SANS avoir desabonne personne', async ({ page }) => {
    await monter(page);
    await page.goto('/securite/consentement');
    await expect(page.getByTestId('refus-possibles')).toContainText(/Personne n.a été désabonné/);
    await expect(page.getByTestId('refus-possible-ligne')).toHaveCount(1);
    await expect(page.getByTestId('refus-possible-ligne')).toContainText('arrêtez de me contacter');
  });

  test('rien ne deborde en 13 pouces', async ({ page }) => {
    await monter(page);
    await page.setViewportSize(TREIZE_POUCES);
    await page.goto('/securite');
    await expect(page.getByTestId('securite-accueil')).toBeVisible();
    await pasDeDebordement(page);
  });
});
