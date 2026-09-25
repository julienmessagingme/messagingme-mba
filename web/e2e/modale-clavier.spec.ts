import { test, expect, type Page } from '@playwright/test';
import { TREIZE_POUCES } from './aide/largeur';

/**
 * LA FENÊTRE MODALE ET LA CONFIRMATION, AU CLAVIER ET À L'HISTORIQUE (jaunes de la passe 2, corrigés en passe 3).
 *
 * Trois défauts que rien ne montrait à la souris :
 * - Échap dans une édition en ligne de la fiche contact fermait TOUTE la fiche, pas seulement l'édition ;
 * - à la fermeture d'une confirmation, le focus tombait sur `body` au lieu de revenir au bouton d'origine ;
 * - la confirmation survivait à un retour arrière du navigateur, et « oui » exécutait alors le geste de la
 *   page quittée.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const CONTACT = {
  id: '5f0c1b2e-7d4a-4c8e-9b1a-2f3e4d5c6b7a', profileName: 'Camille Externe', phoneE164: '+33600000011', externalId: null,
  bsuid: null, optInStatus: 'opted_in', tags: [], fields: {}, createdAt: '2026-01-01T00:00:00Z', whatsappJoignable: null, whatsappJoignableLe: null,
};

async function mock(page: Page, suppressions: string[]): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = req.url().split('?')[0]!;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'DELETE') { suppressions.push(chemin); return json({ ok: true }); }
    if (chemin.endsWith('/conversations/todo-count')) return json({ count: 0 });
    if (chemin.endsWith('/contacts')) return json({ contacts: [CONTACT], total: 1 });
    if (chemin.endsWith('/user-fields')) return json({ fields: [] });
    if (chemin.endsWith('/tags')) return json({ tags: [] });
    if (/\/agents$/.test(chemin)) return json({ agents: [{ id: 'ag1', label: 'Conseiller séjours', status: 'draft', sorties: [], modele: 'anthropic/claude-haiku-4.5' }] });
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Modale et confirmation : clavier et historique', () => {
  test.use({ viewport: TREIZE_POUCES });

  test('🔴 Échap annule l’édition en ligne de la fiche contact, sans fermer la fiche', async ({ page }) => {
    await mock(page, []);
    await page.goto('/contacts');
    await page.getByText('Camille Externe').first().click();
    await expect(page.getByTestId('fiche-identifiant-api')).toBeVisible();

    // La fiche porte déjà ses propres champs (l'ajout d'étiquette) : on compte l'édition en plus d'eux.
    const fiche = page.getByRole('dialog');
    const champsAvant = await fiche.locator('input').count();
    await page.getByTestId('champ-modifier').first().click();
    await expect(fiche.locator('input')).toHaveCount(champsAvant + 1);
    await expect(fiche.locator('input:focus')).toHaveCount(1);
    await page.keyboard.press('Escape');

    // L'édition est annulée…
    await expect(fiche.locator('input')).toHaveCount(champsAvant);
    // … et la fiche est toujours là.
    await expect(page.getByTestId('fiche-identifiant-api')).toBeVisible();

    // Un second Échap, lui, ferme la fiche : la Modale n'ignore que la touche déjà traitée.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('fiche-identifiant-api')).toHaveCount(0);
  });

  test('🔴 fermer une confirmation rend le focus au bouton qui l’a ouverte', async ({ page }) => {
    await mock(page, []);
    await page.goto('/agents');
    const bouton = page.getByTestId('agent-supprimer-ag1');
    await bouton.focus();
    await page.keyboard.press('Enter');
    // Le bouton « oui » prend le focus à l'ouverture (`autoFocus`) : c'est lui qui trompait la fenêtre.
    await expect(page.getByTestId('confirmation-oui')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('confirmation')).toHaveCount(0);
    await expect(bouton).toBeFocused();
  });

  test('🔴 un retour arrière répond « non » à la confirmation en cours', async ({ page }) => {
    const suppressions: string[] = [];
    await mock(page, suppressions);
    await page.goto('/accueil');
    // Navigation DANS l'application (le fournisseur de confirmation vit à la racine et survit donc au
    // changement de page), puis retour arrière du navigateur.
    await page.getByRole('button', { name: 'AI Agent' }).click();
    await page.getByRole('button', { name: 'Other AI agent' }).click();
    await page.getByRole('link', { name: 'Agents', exact: true }).click();
    await expect(page).toHaveURL(/\/agents/);

    await page.getByTestId('agent-supprimer-ag1').click();
    await expect(page.getByTestId('confirmation')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/accueil/);

    // La question a disparu avec la page qui la posait, et rien n'a été supprimé.
    await expect(page.getByTestId('confirmation')).toHaveCount(0);
    expect(suppressions).toEqual([]);
  });
});
