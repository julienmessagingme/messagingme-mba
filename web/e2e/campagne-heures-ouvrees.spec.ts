import { test, expect } from '@playwright/test';

/**
 * « Envoyer uniquement pendant les heures ouvrées » (demande de Julien du 2026-09-08).
 *
 * 🔴 CE QUE SEUL UN TEST DE BOUT EN BOUT PEUT VOIR. Le moteur est tenu par des tests unitaires, mais il lit
 * une colonne, et cette colonne n'existe que si l'écran l'envoie. Une case qui s'affiche, se coche, et dont
 * personne ne transmet la valeur donne exactement ce qu'il ne faut pas : un client convaincu d'avoir protégé
 * ses nuits, et une campagne qui part à 3 h.
 *
 * Elle vaut pour « Maintenant » COMME pour « Plus tard », parce que c'est une contrainte de la campagne et
 * non de son lancement : les deux chemins sont vérifiés séparément, l'un ne prouve pas l'autre (ce sont deux
 * boutons distincts, chacun construisant sa charge utile).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONTACTS = [
  { id: 'c1', phoneE164: '+33600000001', profileName: 'Contact 1', tags: [], fields: {}, optInStatus: 'opted_in', createdAt: '2026-09-01T00:00:00.000Z' },
];

async function monter(page: import('@playwright/test').Page, corps: Array<Record<string, unknown>>) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && /\/campaigns$/.test(url)) {
      corps.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ campaignId: 'camp1', recipientCount: 1, skipped: [] }) });
    }
    if (req.method() === 'POST' && /\/campaigns\/camp1\/run$/.test(url)) return json({ ok: true });
    if (url.includes('/contacts/count')) return json({ total: 1 });
    if (url.includes('/contacts')) return json({ contacts: CONTACTS, total: 1 });
    if (url.includes('/template-params')) return json({ hints: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.includes('/campaign-drafts')) return json({ drafts: [] });
    if (url.includes('/campaigns')) return json({ campaigns: [] });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33525680250', verifiedName: 'Demo' }] });
    if (url.includes('/templates')) return json({ templates: [{ name: 'promo', language: 'fr', category: 'MARKETING', status: 'APPROVED', body: 'Bonjour', buttons: [] }] });
    if (url.endsWith('/workflows')) return json({ workflows: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
  await page.goto('/campaigns');
  await page.getByRole('button', { name: /Ajouter une campagne/i }).click();
  await page.getByTestId('campaign-name').fill('Campagne de nuit');
  // Un destinataire et un template : le minimum pour que l'étape d'envoi s'ouvre.
  await page.getByRole('checkbox').first().check();
  const tpl = page.locator('select').filter({ has: page.locator('option', { hasText: 'promo' }) }).first();
  await expect(tpl).toBeVisible({ timeout: 15_000 });
  await tpl.selectOption({ index: 1 });
  await expect(page.getByTestId('campagne-heures-ouvrees')).toBeVisible({ timeout: 15_000 });
}

test.describe('Campagne : envoyer uniquement pendant les heures ouvrées', () => {
  test('🔴 cochée, la contrainte part avec la campagne (« Maintenant »)', async ({ page }) => {
    const corps: Array<Record<string, unknown>> = [];
    await monter(page, corps);

    const case_ = page.getByTestId('campagne-heures-ouvrees');
    await expect(case_).not.toBeChecked(); // le défaut ne contraint personne
    await case_.check();
    // L'écran DIT ce qui se passera hors créneau : sans ça, une campagne en pause ressemble à une panne.
    await expect(page.getByText(/attend la prochaine ouverture/i)).toBeVisible();

    await page.getByRole('button', { name: /Créer et lancer/ }).click();
    await expect.poll(() => corps.length, { timeout: 15_000 }).toBe(1);
    expect(corps[0]).toMatchObject({ businessHoursOnly: true });
  });

  test('🔴 cochée, elle part AUSSI avec un lancement « Plus tard »', async ({ page }) => {
    // L'autre bouton, l'autre charge utile. Julien a demandé les deux, et un seul des deux chemins vérifié
    // aurait laissé passer l'oubli sur l'autre.
    const corps: Array<Record<string, unknown>> = [];
    await monter(page, corps);

    await page.getByRole('button', { name: 'Plus tard', exact: true }).click();
    await page.locator('input[type="datetime-local"]').fill('2099-01-01T09:00');
    await page.getByTestId('campagne-heures-ouvrees').check();

    await page.getByRole('button', { name: /Créer et planifier/ }).click();
    await expect.poll(() => corps.length, { timeout: 15_000 }).toBe(1);
    expect(corps[0]).toMatchObject({ businessHoursOnly: true });
  });

  test('🔴 DÉCOCHÉE, rien n’est envoyé : le parc entier garde son comportement', async ({ page }) => {
    // La preuve inverse. Sans elle, un `businessHoursOnly: false` envoyé partout passerait ce fichier, et
    // une valeur toujours transmise finirait par ressembler à une contrainte que personne n'a demandée.
    const corps: Array<Record<string, unknown>> = [];
    await monter(page, corps);

    await page.getByRole('button', { name: /Créer et lancer/ }).click();
    await expect.poll(() => corps.length, { timeout: 15_000 }).toBe(1);
    expect(corps[0]!.businessHoursOnly).toBeUndefined();
  });
});
