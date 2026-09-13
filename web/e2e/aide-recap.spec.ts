import { test, expect } from '@playwright/test';
import { TREIZE_POUCES, pasDeDebordement } from './aide/largeur';

/**
 * LE RÉCAP D'HIER, dans le bot d'aide.
 *
 * 🔴 CE QUI EST VÉRIFIÉ ICI, ET QU'AUCUN TEST UNITAIRE NE PEUT VOIR : le bouton est MASQUÉ pour un opérateur
 * (pas grisé), il dit qu'il parle d'HIER, il part sans qu'on ait à taper quoi que ce soit, il n'envoie
 * AUCUNE date, et sa réponse s'affiche dans le fil comme un échange ordinaire.
 */
const ADMIN = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const RECAP = {
  sait: true,
  texte: 'Le samedi 12 septembre : 42 conversations (dont 6 nouvelles), 128 messages reçus et 96 envoyés.',
  sources: [],
  ecrans: [{ cle: 'dashboard-quali', href: '/dashboard/quali', fr: 'Qualitatif', en: 'Qualitative', chemin: [] }],
};

async function mock(page: import('@playwright/test').Page, role: string, vues: Array<Record<string, unknown>>) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), { ...ADMIN, role });
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    // ⚠️ Le récap AVANT `/aide` tout court : l'un est un préfixe de l'autre, et tester le plus court d'abord
    // enverrait la demande de récap dans la route des questions sans que rien ne le signale.
    if (url.includes('/aide/recap')) {
      vues.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
      return json(RECAP);
    }
    if (url.includes('/aide')) return json({ sait: false, texte: '', sources: [], ecrans: [] });
    // Les bouchons dont l'écran a besoin pour se rendre : sans eux React démonte la page et le bouton d'aide
    // disparaît avec elle, ce qui ressemble à un défaut du bouton.
    if (url.includes('/contacts/count')) return json({ total: 0 });
    if (url.includes('/contacts')) return json({ contacts: [], total: 0 });
    if (url.includes('/template-params')) return json({ hints: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.includes('/campaign-drafts')) return json({ drafts: [] });
    if (url.includes('/campaigns')) return json({ campaigns: [] });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.endsWith('/workflows')) return json({ workflows: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
}

test.describe('Le récap d’hier', () => {
  test('⚠️ le bouton parle d’HIER, pas « du jour »', async ({ page }) => {
    // « Récap du jour » pour un récap de la veille laisserait quelqu'un se demander à 16 h pourquoi ses
    // conversations du matin n'y sont pas.
    await mock(page, 'admin', []);
    await page.goto('/campaigns');
    await page.getByTestId('aide-bouton').click();
    await expect(page.getByTestId('aide-recap')).toContainText(/récap d.hier/i);
  });

  test('🔴 un clic suffit, aucune date ne part, et la réponse entre dans le fil', async ({ page }) => {
    const vues: Array<Record<string, unknown>> = [];
    await mock(page, 'admin', vues);
    await page.goto('/campaigns');
    await page.getByTestId('aide-bouton').click();
    await page.getByTestId('aide-recap').click();

    await expect(page.getByTestId('aide-reponse')).toContainText('42 conversations');
    await expect(page.getByTestId('aide-question-posee')).toContainText(/récap d.hier/i);
    // 🔴 Le jour est choisi par le SERVEUR. Le corps ne porte que la langue.
    expect(vues).toHaveLength(1);
    expect(Object.keys(vues[0] ?? {})).toEqual(['langue']);
  });

  test('🔴 un opérateur ne voit pas le bouton du tout', async ({ page }) => {
    // MASQUÉ et pas grisé : un bouton grisé lui dirait que ses collègues ont une fonctionnalité qu'il
    // n'aura jamais, ce qui n'est que du bruit. La garde qui compte reste le 403 du serveur.
    await mock(page, 'agent', []);
    await page.goto('/inbox');
    await page.getByTestId('aide-bouton').click();
    await expect(page.getByTestId('aide-accueil')).toBeVisible();
    await expect(page.getByTestId('aide-recap')).toHaveCount(0);
  });

  test('un manager le voit : le récap est pour l’encadrement, pas pour les seuls admins', async ({ page }) => {
    await mock(page, 'manager', []);
    await page.goto('/inbox');
    await page.getByTestId('aide-bouton').click();
    await expect(page.getByTestId('aide-recap')).toBeVisible();
  });

  test('rien ne déborde en 13 pouces', async ({ page }) => {
    await mock(page, 'admin', []);
    await page.setViewportSize(TREIZE_POUCES);
    await page.goto('/campaigns');
    await page.getByTestId('aide-bouton').click();
    await page.getByTestId('aide-recap').click();
    await expect(page.getByTestId('aide-reponse')).toBeVisible();
    await pasDeDebordement(page);
  });
});
