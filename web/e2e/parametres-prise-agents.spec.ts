import { test, expect } from '@playwright/test';

/**
 * PARAMÈTRES S'OUVRE AUX MANAGERS POUR UN SEUL RÉGLAGE (2026-09-19, demande de Julien : « une option à la main
 * des admins et des managers pour que les agents puissent ou non [prendre] la conversation »).
 *
 * 🔴 CE QUE SEUL UN TEST DE BOUT EN BOUT PEUT VOIR ICI : ce que l'écran MONTRE à chaque rôle. Le serveur tient
 * la frontière de son côté (`tests/http-agents-peuvent-prendre.test.ts`) ; si l'écran montrait le fuseau ou les
 * prix à un manager, il lui promettrait des réglages que le serveur refuserait.
 */
async function monter(page: import('@playwright/test').Page, role: string, patches: unknown[] = []) {
  const session = { token: 'e2e-token', email: 'moi@e2e.test', role, tenantId: 't-e2e' };
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), session);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = req.url().split('?')[0]!;
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/settings/agents-peuvent-prendre')) {
      if (role === 'agent') return json({ error: 'interdit' }, 403);
      if (req.method() === 'PATCH') { patches.push(req.postDataJSON()); return json(req.postDataJSON()); }
      return json({ actif: false });
    }
    // Le reste des réglages est ADMIN, comme sur le vrai serveur.
    if (chemin.endsWith('/settings')) {
      return role === 'admin'
        ? json({ mbaEnabled: false, autoRetryEnabled: false, timezone: 'Europe/Paris', businessHours: {} })
        : json({ error: 'action réservée aux administrateurs' }, 403);
    }
    if (chemin.endsWith('/contacts/blocked')) return json({ contacts: [] });
    if (chemin.endsWith('/unread-count')) return json({ count: 0 });
    if (chemin.endsWith('/me')) return json({ email: 'moi@e2e.test', name: 'Moi', role });
    return json({});
  });
  await page.goto('/parametres');
}

test.describe('Paramètres : le réglage de la prise par les agents', () => {
  test('🔴 un MANAGER ne voit QUE ce réglage, et peut le changer', async ({ page }) => {
    const patches: unknown[] = [];
    await monter(page, 'manager', patches);
    await expect(page.getByTestId('param-prise-agents')).toBeVisible();
    // Le fuseau, les horaires et la relance restent admin : ne pas les montrer, c'est ne pas les promettre.
    await expect(page.getByTestId('param-timezone')).toHaveCount(0);
    await expect(page.getByTestId('param-auto-retry-card')).toHaveCount(0);

    await page.getByTestId('param-prise-agents-toggle').click();
    await expect.poll(() => patches.length, { timeout: 10_000 }).toBe(1);
    expect(patches[0]).toEqual({ actif: true });
  });

  test('un ADMIN voit ce réglage PARMI les autres', async ({ page }) => {
    await monter(page, 'admin');
    await expect(page.getByTestId('param-timezone')).toBeVisible();
    await expect(page.getByTestId('param-prise-agents')).toBeVisible();
  });

  test('🔴 un AGENT n’y a pas accès : il s’autoriserait lui-même', async ({ page }) => {
    await monter(page, 'agent');
    await expect(page.getByTestId('param-prise-agents-toggle')).toHaveCount(0);
  });
});
