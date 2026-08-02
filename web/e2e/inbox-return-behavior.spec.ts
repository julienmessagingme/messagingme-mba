import { test, expect } from '@playwright/test';

/**
 * E2E inbox : la surcharge de reprise par conversation (C.4). Ouvrir un fil, changer « À la reprise »
 * vers « reste à traiter » -> PATCH /conversations/:id/return-behavior avec behavior='inbox'.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const CONV = { id: 'c1', waId: '33600000001', profileName: 'Alice Retour', lastPreview: 'coucou', lastMessageAt: '2026-08-02T10:00:00Z', controlOwner: 'app_human' };
const THREAD = {
  waId: '33600000001', windowOpen: true, lastInboundAt: '2026-08-02T10:00:00Z', controlOwner: 'app_human',
  returnBehavior: null, messages: [{ id: 'm1', direction: 'in', type: 'text', body: 'coucou', buttonPayload: null, createdAt: '2026-08-02T10:00:00Z' }],
};

test.describe('Inbox : surcharge de reprise par conversation (C.4)', () => {
  test('changer « À la reprise » vers « reste à traiter » PATCHe behavior=inbox', async ({ page }) => {
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    const patched: Array<Record<string, unknown>> = [];
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.endsWith('/return-behavior') && req.method() === 'PATCH') {
        const body = req.postDataJSON() as Record<string, unknown>;
        patched.push(body);
        return json({ returnBehavior: body.behavior });
      }
      if (url.endsWith('/c1/messages')) return json(THREAD);
      if (url.endsWith('/conversations')) return json({ conversations: [CONV] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await page.goto('/inbox');
    await page.getByText('Alice Retour').click(); // ouvre le fil

    const select = page.getByTestId('thread-return-select');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue(''); // au départ : suit le défaut du compte
    await select.selectOption('inbox');

    await expect.poll(() => patched.length).toBeGreaterThan(0);
    expect(patched[patched.length - 1]).toEqual({ behavior: 'inbox' });
    await expect(select).toHaveValue('inbox');
  });
});
