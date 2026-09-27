import { test, expect, type Page } from '@playwright/test';

/**
 * L'APP SALESFORCE, vue de l'écran (plan 2026-09-26, lot L1) : la carte de Paramètres > Intégrations, la page de
 * connexion et le guide public. Le serveur tient ses frontières de son côté (`tests/http-salesforce.test.ts`) ;
 * ici, on regarde ce que l'écran MONTRE et ce qu'il ENVOIE, contre une API simulée.
 */
const ORG = {
  orgId: '00DQL00000ch3nx2AA', myDomain: 'https://acme.my.salesforce.com', sandbox: false, etat: 'connectee', motifCoupure: null,
  quota: { utilise: 18, max: 15000, releveLe: '2026-09-27T10:00:00.000Z' }, consentementLead: null, consentementContact: null,
  envoyerResume: false, proprietaireRepli: null, connecteeLe: '2026-09-27T10:00:00.000Z',
};
const VUE = { actif: false, cleAppPosee: true, chiffrementPret: true, liensInstallation: { production: 'https://login.salesforce.com/packaging/installPackage.apexp?p0=04tQL00000abcdeYAB', sandbox: 'https://test.salesforce.com/packaging/installPackage.apexp?p0=04tQL00000abcdeYAB' }, org: null };

interface Trace { patchs: unknown[]; connexions: unknown[] }

async function monter(page: Page, o: {
  role?: string;
  vue?: Record<string, unknown> | 'absente';
  connexion?: { status: number; corps: unknown };
  apresConnexion?: Record<string, unknown>;
  chemin?: string;
}): Promise<Trace> {
  const trace: Trace = { patchs: [], connexions: [] };
  const session = { token: 'e2e-token', email: 'moi@e2e.test', role: o.role ?? 'admin', tenantId: 't-e2e' };
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), session);
  let vue = o.vue ?? VUE;
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = req.url().split('?')[0]!;
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/integrations/salesforce/actif') && req.method() === 'PATCH') {
      const corps = req.postDataJSON() as { actif: boolean };
      trace.patchs.push(corps);
      if (vue !== 'absente') vue = { ...vue, actif: corps.actif };
      return json({ salesforceActif: corps.actif });
    }
    if (chemin.endsWith('/integrations/salesforce/connexion')) {
      trace.connexions.push(req.postDataJSON());
      const r = o.connexion ?? { status: 200, corps: { ok: true, orgId: ORG.orgId, sandbox: false } };
      if (r.status === 200 && o.apresConnexion) vue = o.apresConnexion;
      return json(r.corps, r.status);
    }
    if (chemin.endsWith('/integrations/salesforce')) {
      // Le 404 exact du routeur Fastify : c'est lui qui dit « API pas encore déployée ».
      if (vue === 'absente') return json({ message: 'Route GET not found', error: 'Not Found', statusCode: 404 }, 404);
      return json(vue);
    }
    if (chemin.endsWith('/settings')) return json({ mbaEnabled: false, timezone: 'Europe/Paris', businessHours: {} });
    if (chemin.endsWith('/account-status')) return json({ hasNumber: false, hubspotPortal: { connected: false } });
    if (chemin.endsWith('/integrations/batch')) return json({ branche: false });
    if (chemin.endsWith('/settings/agents-peuvent-prendre')) return json({ actif: false });
    if (chemin.endsWith('/contacts/blocked')) return json({ contacts: [] });
    if (chemin.endsWith('/unread-count')) return json({ count: 0 });
    if (chemin.endsWith('/me')) return json({ email: 'moi@e2e.test', name: 'Moi', role: o.role ?? 'admin' });
    return json({});
  });
  await page.goto(o.chemin ?? '/parametres');
  return trace;
}

test.describe('Paramètres > Intégrations > Salesforce : la carte', () => {
  test('🔴 éteint : on l’allume, l’écran envoie `actif: true`, puis mène à la page de connexion et au guide', async ({ page }) => {
    const trace = await monter(page, {});
    const bouton = page.getByTestId('integration-salesforce-toggle');
    await expect(page.getByTestId('integration-salesforce-etat')).toContainText('Éteint');
    await expect(page.getByTestId('integration-salesforce-page')).toHaveCount(0);
    await bouton.click();
    await expect.poll(() => trace.patchs.length, { timeout: 10_000 }).toBe(1);
    expect(trace.patchs[0]).toEqual({ actif: true });
    await expect(page.getByTestId('integration-salesforce-page')).toHaveAttribute('href', '/parametres/salesforce');
    await expect(page.getByTestId('integration-salesforce-tuto')).toHaveAttribute('href', '/tuto-salesforce');
  });

  test('🔴 API pas encore déployée (404 du routeur) : AUCUNE carte, plutôt qu’un bouton vers une route absente', async ({ page }) => {
    await monter(page, { vue: 'absente' });
    await expect(page.getByTestId('integration-hubspot')).toBeVisible();
    await expect(page.getByTestId('integration-salesforce')).toHaveCount(0);
  });

  test('🔴 org reliée : l’interrupteur est grisé et la raison est dite, l’org est nommée', async ({ page }) => {
    const trace = await monter(page, { vue: { ...VUE, actif: true, org: ORG } });
    await expect(page.getByTestId('integration-salesforce-toggle')).toBeDisabled();
    await expect(page.getByTestId('integration-salesforce-raison')).toContainText('déconnectez-la');
    await expect(page.getByTestId('integration-salesforce-etat')).toContainText('acme.my.salesforce.com');
    expect(trace.patchs).toEqual([]);
  });
});

test.describe('Paramètres > Intégrations > Salesforce : la page de connexion', () => {
  test('les liens d’installation viennent du serveur', async ({ page }) => {
    await monter(page, { vue: { ...VUE, actif: true }, chemin: '/parametres/salesforce' });
    await expect(page.getByTestId('salesforce-installation').getByRole('link', { name: 'Installer en production' }))
      .toHaveAttribute('href', VUE.liensInstallation.production);
  });

  test('🔴 un manque s’affiche avec le lien vers SON étape du guide, et rien n’est présenté comme relié', async ({ page }) => {
    const trace = await monter(page, {
      vue: { ...VUE, actif: true },
      chemin: '/parametres/salesforce',
      connexion: { status: 422, corps: { error: 'désignez l’utilisateur', manques: [{ etape: 'run-as', message: 'Désignez l’utilisateur d’intégration « Run As ».' }] } },
    });
    await page.getByTestId('salesforce-adresse').fill('https://acme.my.salesforce.com');
    await page.getByTestId('salesforce-connecter').click();
    const manques = page.getByTestId('salesforce-manques');
    await expect(manques).toContainText('Run As');
    await expect(manques.getByRole('link')).toHaveAttribute('href', '/tuto-salesforce#run-as');
    expect(trace.connexions).toEqual([{ adresse: 'https://acme.my.salesforce.com' }]);
    await expect(page.getByTestId('salesforce-etat')).toContainText('Aucune org');
  });

  test('connexion réussie : la page relit l’état et nomme l’org', async ({ page }) => {
    await monter(page, {
      vue: { ...VUE, actif: true },
      apresConnexion: { ...VUE, actif: true, org: ORG },
      chemin: '/parametres/salesforce',
    });
    await page.getByTestId('salesforce-adresse').fill('https://acme.my.salesforce.com');
    await page.getByTestId('salesforce-connecter').click();
    await expect(page.getByTestId('salesforce-message')).toContainText('Org Salesforce reliée');
    await expect(page.getByTestId('salesforce-etat')).toContainText('Reliée à acme.my.salesforce.com');
    await expect(page.getByTestId('salesforce-deconnecter')).toBeVisible();
  });

  test('🔴 un manager ne voit pas la page : elle le dit elle-même (AppShell le laisse entrer sous Paramètres)', async ({ page }) => {
    await monter(page, { role: 'manager', vue: { ...VUE, actif: true }, chemin: '/parametres/salesforce' });
    await expect(page.getByTestId('salesforce-reserve')).toBeVisible();
    await expect(page.getByTestId('salesforce-connexion')).toHaveCount(0);
  });
});

test.describe('le guide public', () => {
  test('sans session, il porte une ancre par étape de la connexion', async ({ page }) => {
    await page.goto('/tuto-salesforce');
    for (const etape of ['package', 'utilisateur', 'droits', 'run-as', 'adresse', 'org']) {
      await expect(page.locator(`li#${etape}`)).toBeVisible();
    }
  });
});
