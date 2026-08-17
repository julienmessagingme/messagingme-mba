import { test, expect } from '@playwright/test';

/**
 * Session expirée pendant l'édition d'un scénario. Deux comportements verrouillés ensemble, parce qu'ils se
 * sont manifestés ensemble :
 *
 * 1. 🔴 L'auto-save relançait la sauvegarde après un ÉCHEC. Le drapeau « sale » étant posé par l'échec
 *    lui-même, une erreur persistante (session expirée en tête) bouclait sans aucun délai, martelant l'API,
 *    même après avoir quitté l'écran.
 * 2. La session tombée n'affichait qu'un message dans un coin, le reste de l'interface restait actif et rien
 *    ne disait comment se reconnecter.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
// Un bloc suffit, et il est NÉCESSAIRE : « Auto-arranger » est désactivé sur un graphe vide.
const GRAPH = { nodes: [{ id: 'n1', type: 'tag', position: { x: 0, y: 0 }, data: { wfType: 'tag', tag: 'vip' } }], edges: [] };

test.describe('session expirée', () => {
  test('🔴 un 401 persistant ne fait PAS boucler la sauvegarde, et propose de se reconnecter', async ({ page }) => {
    let patchs = 0;
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      // TOUTE sauvegarde échoue en 401 : c'est le cas d'une session tombée en pleine édition.
      if (req.method() === 'PATCH' && /\/workflows\/wf1$/.test(url)) {
        patchs += 1;
        return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'jeton invalide' }) });
      }
      if (/\/workflows\/wf1$/.test(url)) return json({ workflow: { id: 'wf1', name: 'Scénario E2E', graph: GRAPH, createdAt: '', updatedAt: '' } });
      if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Scénario E2E', graph: GRAPH }] });
      if (url.includes('/templates')) return json({ templates: [] });
      if (url.includes('/flows')) return json({ flows: [] });
      if (url.includes('/tags')) return json({ tags: [] });
      if (url.includes('/user-fields')) return json({ fields: [] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await page.goto('/workflows?open=wf1');

    // Une modification quelconque déclenche l'auto-save, qui échouera.
    await page.getByTestId('workflow-autoarrange').click(); // déclenche l'enregistrement, comme les autres specs du builder

    // La bannière arrive, avec un chemin de sortie VISIBLE (avant : un message dans un coin, et rien d'autre).
    const banniere = page.getByTestId('session-expiree');
    await expect(banniere).toBeVisible();
    await expect(page.getByTestId('session-expiree-reconnecter')).toBeVisible();

    // Puis on laisse le temps à une éventuelle boucle de se manifester. Avant le correctif, le nombre d'appels
    // partait à l'infini ; désormais il reste borné (l'échec ne relance plus, seul le debounce ou le bouton
    // « réessayer » reprennent la main).
    const apresBanniere = patchs;
    await page.waitForTimeout(2500);
    expect(patchs - apresBanniere).toBeLessThanOrEqual(1);
    expect(patchs).toBeLessThanOrEqual(3);
  });

  test('le bouton Reconnecter ramène à l’écran de connexion', async ({ page }) => {
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      if (url.endsWith('/me')) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'expiré' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
    });

    await page.goto('/accueil');
    await page.getByTestId('session-expiree-reconnecter').click();
    await expect(page).toHaveURL(/\/login/);
  });
});
