import { test, expect } from '@playwright/test';

/**
 * E2E campagne : ENCHAÎNER deux campagnes sans quitter l'écran.
 *
 * Ce fichier existe à cause d'un bug vécu le 2026-08-19. Après un lancement, les phases terminales de la
 * machine à états MASQUAIENT les boutons d'action, alors que le formulaire restait éditable. L'opérateur a
 * saisi une deuxième campagne devant un écran ne proposant plus que « Nouvelle campagne » : ce bouton a effacé
 * sa saisie sans rien lancer, et seul un rafraîchissement a débloqué l'écran.
 *
 * Le comportement attendu, dans ses mots : « quand une campagne est lancée, il faut qu'on puisse tout de suite
 * en refaire une autre sans qu'on ait de trace de la précédente ».
 *
 * Le lancement fait tourner un polling de 6 tours x 2 s, donc ce test attend RÉELLEMENT une douzaine de
 * secondes par campagne : d'où le timeout élargi. C'est le prix d'un test qui suit le vrai parcours.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const CONTACTS = [
  { id: 'c1', phoneE164: '+33611111111', bsuid: null, profileName: 'Alex', optInStatus: 'opted_in', fields: {}, tags: [], createdAt: '2026-08-01T09:00:00.000Z' },
];
const WF = {
  id: 'wf-ok', name: 'Relance promo', graph: {
    nodes: [{ id: 'n1', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo', language: 'fr' } }], edges: [],
  },
};

test.describe('Campagnes : enchaîner sans trace de la précédente', () => {
  test('🔴 après un lancement, le formulaire est neuf et une 2e campagne part vraiment', async ({ page }) => {
    test.setTimeout(150_000); // deux lancements, chacun avec son polling réel de ~12 s

    const creations: Array<Record<string, unknown>> = [];
    const runs: string[] = [];
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (req.method() === 'POST' && /\/campaigns$/.test(new URL(url).pathname)) {
        creations.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
        return json({ campaignId: `camp-${creations.length}`, recipientCount: 1, skipped: [] });
      }
      if (req.method() === 'POST' && url.includes('/run')) {
        runs.push(url);
        return json({ ok: true });
      }
      if (url.includes('/campaigns/camp-')) {
        return json({ id: 'camp-1', name: 'x', status: 'sent', counts: { queued: 0, sent: 1, delivered: 1, read: 0, failed: 0 }, recipients: [] });
      }
      if (url.endsWith('/workflows')) return json({ workflows: [WF] });
      if (url.includes('/templates')) return json({ templates: [{ name: 'promo', language: 'fr', status: 'APPROVED', category: 'marketing', body: 'Bonjour' }] });
      if (url.includes('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33500000000', verifiedName: 'Test' }] });
      if (url.includes('/contacts/count')) return json({ count: CONTACTS.length });
      if (url.includes('/contacts')) return json({ contacts: CONTACTS });
      if (url.includes('/campaigns')) return json({ campaigns: [] });
      if (url.includes('/user-fields')) return json({ fields: [] });
      if (url.includes('/tags')) return json({ tags: [] });
      if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await page.goto('/campaigns');
    await page.getByRole('button', { name: /Ajouter une campagne/i }).click();

    const lancer = page.getByRole('button', { name: 'Créer et lancer', exact: true });
    const nom = page.getByTestId('campaign-name');

    // ---- 1re campagne : par TEMPLATE (le mode par défaut) ----
    await nom.fill('Campagne une');
    await page.getByRole('checkbox').first().check();
    const tplSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'promo' }) }).first();
    await expect(tplSelect).toBeVisible({ timeout: 15_000 });
    await tplSelect.selectOption({ index: 1 });
    await expect(lancer).toBeEnabled({ timeout: 15_000 });
    await lancer.click();

    // ---- le lancement aboutit : resultat affiche, formulaire NEUF, bouton de nouveau disponible ----
    await expect(page.getByTestId('campagne-dernier-envoi')).toBeVisible({ timeout: 60_000 });
    expect(creations).toHaveLength(1);
    // 🔴 Le formulaire ne porte plus la campagne precedente : c'est « sans trace de la precedente ».
    await expect(nom).toHaveValue('');
    // 🔴 Le piege d'origine a disparu : plus de bouton « Nouvelle campagne », qui laissait croire qu'il fallait
    // une action pour repartir et effacait la saisie en cours quand on le prenait pour « Lancer ».
    await expect(page.getByRole('button', { name: /Nouvelle campagne/i })).toHaveCount(0);

    // ---- 2e campagne : par SCENARIO, sans rafraichir la page ----
    await nom.fill('Campagne deux');
    await page.getByRole('checkbox').first().check();
    await page.getByRole('button', { name: 'Un scénario', exact: true }).click();
    const wfSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Choisir un scénario' }) });
    await expect(wfSelect).toBeVisible({ timeout: 15_000 });
    await wfSelect.selectOption({ index: 1 });
    // 🔴 LE COEUR DU BUG : l'etape 1 est de nouveau complete, donc le bouton de lancement doit revenir. Il
    // restait masque, et l'operateur n'avait aucun moyen de lancer sa 2e campagne sans rafraichir la page.
    await expect(lancer).toBeVisible({ timeout: 15_000 });
    await expect(lancer).toBeEnabled({ timeout: 15_000 });
    await lancer.click();

    // 🔴 La deuxieme campagne part REELLEMENT : c'est ce qui n'arrivait pas.
    await expect.poll(() => creations.length, { timeout: 60_000 }).toBe(2);
    expect(creations[1]).toMatchObject({ name: 'Campagne deux', workflowId: 'wf-ok' });
    // Le `/run` part juste APRES la creation : une assertion seche ici course avec lui.
    await expect.poll(() => runs.length, { timeout: 30_000 }).toBe(2);
  });

  test('le résultat du dernier envoi se ferme, et un nouveau lancement l’efface', async ({ page }) => {
    test.setTimeout(120_000);

    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (req.method() === 'POST' && /\/campaigns$/.test(new URL(url).pathname)) return json({ campaignId: 'camp-1', recipientCount: 1, skipped: [] });
      if (req.method() === 'POST' && url.includes('/run')) return json({ ok: true });
      if (url.includes('/campaigns/camp-')) return json({ id: 'camp-1', name: 'x', status: 'sent', counts: { queued: 0, sent: 1, delivered: 1, read: 0, failed: 0 }, recipients: [] });
      if (url.includes('/templates')) return json({ templates: [{ name: 'promo', language: 'fr', status: 'APPROVED', category: 'marketing', body: 'Bonjour' }] });
      if (url.includes('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33500000000', verifiedName: 'Test' }] });
      if (url.includes('/contacts/count')) return json({ count: CONTACTS.length });
      if (url.includes('/contacts')) return json({ contacts: CONTACTS });
      if (url.includes('/campaigns')) return json({ campaigns: [] });
      if (url.endsWith('/workflows')) return json({ workflows: [] });
      if (url.includes('/user-fields')) return json({ fields: [] });
      if (url.includes('/tags')) return json({ tags: [] });
      if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await page.goto('/campaigns');
    await page.getByRole('button', { name: /Ajouter une campagne/i }).click();
    await page.getByTestId('campaign-name').fill('Campagne une');
    await page.getByRole('checkbox').first().check();
    const tplSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'promo' }) }).first();
    await expect(tplSelect).toBeVisible({ timeout: 15_000 });
    await tplSelect.selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Créer et lancer', exact: true }).click();

    const resultat = page.getByTestId('campagne-dernier-envoi');
    await expect(resultat).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('campagne-fermer-resultat').click();
    await expect(resultat).toHaveCount(0);
  });
});
