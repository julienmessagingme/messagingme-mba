import { test, expect } from '@playwright/test';
import { mockMba, appelsMba } from './support/mba';

/**
 * Vue d'ensemble : l'allumage de l'agent, l'audience, les interdits de langage.
 *
 * L'allumage est le point sensible de tout l'écran. Meta documente une asymétrie : éteindre arrête l'agent sur
 * TOUTES les conversations, y compris en cours ; rallumer ne reprend que les nouvelles. Un clic par erreur ne
 * se défait donc pas par un second clic, d'où la confirmation obligatoire.
 */
test.describe('MBA Paramètres : vue d’ensemble', () => {
  test('l’allumage DEMANDE confirmation, et n’appelle rien si on refuse', async ({ page }) => {
    const calls = await mockMba(page);
    await page.goto('/mba/parametres');

    let vu = '';
    page.once('dialog', (d) => { vu = d.message(); void d.dismiss(); });
    await page.getByTestId('mba-rollout-toggle').click();

    // Le message doit ANNONCER l'effet sur les fils en cours, pas juste demander « êtes-vous sûr ».
    await expect.poll(() => vu).toContain('NOUVELLES');
    await expect.poll(() => appelsMba(calls, 'PUT', '/rollout').length).toBe(0);
  });

  test('confirmé : PUT rollout, et l’interrupteur REFLÈTE l’état rendu par le serveur', async ({ page }) => {
    const calls = await mockMba(page);
    await page.goto('/mba/parametres');
    await expect(page.getByTestId('mba-rollout-toggle')).toHaveAttribute('aria-pressed', 'false');

    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('mba-rollout-toggle').click();
    await expect.poll(() => appelsMba(calls, 'PUT', '/rollout')[0]?.body).toEqual({ enabled: true });
    // L'assertion qui compte : sans remontée de la réponse dans l'état, l'appel partirait et l'écran
    // continuerait d'afficher « éteint ». L'opérateur ne saurait pas si son geste a pris.
    await expect(page.getByTestId('mba-rollout-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  test('🔴 un refus de Meta s’affiche tel quel et la page tient debout', async ({ page }) => {
    // Cas réel et actuel : Meta refuse l'allumage tant qu'aucun moyen de paiement n'est enregistré, et son
    // message porte le lien exact à suivre. Le remplacer par « une erreur est survenue » perdrait l'essentiel.
    const message = 'Meta: Cannot enable Meta Business Agent : A payment method is required. Add one in the Billing Hub.';
    await mockMba(page, {
      custom: async (route, method, url) => {
        if (method === 'PUT' && url.includes('/rollout')) {
          await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: message }) });
          return true;
        }
        return false;
      },
    });
    await page.goto('/mba/parametres');
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('mba-rollout-toggle').click();

    await expect(page.getByTestId('mba-overview-error')).toContainText('payment method');
    // La page reste utilisable : les onglets répondent encore.
    await page.getByTestId('mba-tab-business').click();
    await expect(page.getByTestId('mba-bi-description')).toBeVisible();
  });

  test('audience et interdits de langage partent en PATCH settings', async ({ page }) => {
    const calls = await mockMba(page);
    await page.goto('/mba/parametres');

    await page.getByTestId('mba-audience').selectOption('ALLOWLISTED_ONLY');
    await expect.poll(() => appelsMba(calls, 'PATCH', '/settings')[0]?.body).toEqual({ aiAudience: 'ALLOWLISTED_ONLY' });

    await page.getByTestId('mba-neversay-input').fill('c’est garanti');
    await page.getByTestId('mba-neversay-add').click();
    await expect.poll(() => appelsMba(calls, 'PATCH', '/settings').at(-1)?.body).toEqual({ neverSay: ['c’est garanti'] });
    // La phrase doit APPARAÎTRE : c'est ce qui prouve que la réponse est remontée dans l'état de l'écran.
    await expect(page.getByTestId('mba-audience')).toHaveValue('ALLOWLISTED_ONLY');
    await expect(page.getByText('c’est garanti')).toBeVisible();
  });

  test('agent pas encore créé chez Meta : ce n’est PAS un blocage général', async ({ page }) => {
    // Seules les compétences exigent un agent_id. Tout le reste doit rester éditable, sinon on rejoue la
    // maquette gelée pour rien.
    await mockMba(page, { status: { onboarded: false, agentId: null, settings: null }, agentId: null });
    await page.goto('/mba/parametres');
    await expect(page.getByTestId('mba-onboarded')).toContainText(/Pas encore|Not yet/);

    await page.getByTestId('mba-tab-business').click();
    await expect(page.getByTestId('mba-bi-description')).toBeEnabled();

    await page.getByTestId('mba-tab-competences').click();
    await expect(page.getByTestId('mba-skills-no-agent')).toBeVisible();
  });
});
