import { test, expect, type Page } from '@playwright/test';
import { repondre } from './aide/confirmation';

/**
 * LES DOSSIERS DES SCÉNARIOS ET DES TEMPLATES (décision de Julien du 2026-10-13, plan
 * `docs/superpowers/plans/2026-10-13-dossiers-scenarios-templates.md`). Le faux serveur garde son état comme le vrai : les
 * dossiers et le rangement que la page lit, et ce que chaque geste y écrit.
 */
const ADMIN = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const W3 = '33333333-3333-4333-8333-333333333333';
const WFS = [
  { id: W1, name: 'Relance panier', nodeCount: 3, createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z' },
  { id: W2, name: 'Prise de rendez-vous', nodeCount: 2, createdAt: '2026-10-02T10:00:00Z', updatedAt: '2026-10-02T10:00:00Z' },
  { id: W3, name: 'Offre -30 %', nodeCount: 1, createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z' },
];
const TPL = (name: string, language: string) => ({ name, language, status: 'APPROVED', category: 'MARKETING', body: 'Bonjour', editable: true });
const TEMPLATES = [TPL('promo_ete', 'fr'), TPL('promo_ete', 'en_US'), TPL('relance_panier', 'fr')];

interface Etat { dossiers: Array<{ id: string; nom: string; type: string }>; rangement: Record<string, Record<string, string>>; appels: Array<{ method: string; url: string; body: unknown }> }

async function monter(page: Page, session: typeof ADMIN, depart: Partial<Etat> = {}): Promise<Etat> {
  const etat: Etat = { dossiers: depart.dossiers ?? [], rangement: depart.rangement ?? { scenario: {}, template: {} }, appels: [] };
  let n = 0;
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), session);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    const corps = method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null);
    if (url.includes('/dossiers')) etat.appels.push({ method, url, body: corps });
    const type = /type=(scenario|template)/.exec(url)?.[1];
    if (/\/dossiers\?type=/.test(url) && method === 'GET') {
      return json({ dossiers: etat.dossiers.filter((d) => d.type === type).map(({ id, nom }) => ({ id, nom })), rangement: etat.rangement[type!] ?? {} });
    }
    if (/\/dossiers\/rangement$/.test(url) && method === 'PUT') {
      const b = corps as { type: string; cles: string[]; dossierId: string | null };
      for (const c of b.cles) {
        if (b.dossierId === null) delete etat.rangement[b.type]![c];
        else etat.rangement[b.type]![c] = b.dossierId;
      }
      return json({ ranges: b.cles.length });
    }
    if (/\/dossiers$/.test(url) && method === 'POST') {
      const b = corps as { type: string; nom: string };
      if (etat.dossiers.some((d) => d.type === b.type && d.nom.toLowerCase() === b.nom.toLowerCase())) return json({ error: 'un dossier porte déjà ce nom' }, 409);
      const d = { id: `d${++n}-0000-4000-8000-000000000000`.slice(0, 36), nom: b.nom, type: b.type };
      etat.dossiers.push(d);
      return json({ dossier: { id: d.id, nom: d.nom } }, 201);
    }
    const sur = /\/dossiers\/([^/?]+)$/.exec(url);
    if (sur && method === 'PATCH') {
      const d = etat.dossiers.find((x) => x.id === sur[1])!;
      d.nom = String((corps as { nom: string }).nom);
      return json({ dossier: { id: d.id, nom: d.nom } });
    }
    if (sur && method === 'DELETE') {
      etat.dossiers = etat.dossiers.filter((x) => x.id !== sur[1]);
      for (const t of Object.keys(etat.rangement)) for (const [c, d] of Object.entries(etat.rangement[t]!)) if (d === sur[1]) delete etat.rangement[t]![c];
      return json({ supprime: true });
    }
    if (/\/workflows\/[^/]+\/duplicate$/.test(url)) return json({ id: 'copie-0000-4000-8000-000000000000', name: 'Relance panier (copie)', graph: { nodes: [], edges: [] } }, 201);
    if (url.endsWith('/workflows')) return json({ workflows: WFS });
    if (/\/templates$/.test(url)) return json({ templates: TEMPLATES });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false });
    if (url.endsWith('/me')) return json({ email: session.email, name: 'Jean Test', role: session.role });
    return json({});
  });
  return etat;
}

const SAV = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nom: 'SAV', type: 'scenario' };
const PROMOS = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', nom: 'Promos', type: 'template' };

test.describe('Dossiers : la page Scénarios', () => {
  test('🔴 on crée un dossier, on y range un scénario à l’unité, et l’onglet filtre', async ({ page }) => {
    const etat = await monter(page, ADMIN);
    await page.goto('/workflows');
    await expect(page.getByTestId('dossier-onglet-tous')).toContainText('3');
    await page.getByTestId('dossier-creer').click();
    await page.getByTestId('dossier-nom').fill('Black Friday');
    await page.getByTestId('dossier-enregistrer').click();
    // Le dossier neuf devient l'onglet actif : il est vide.
    await expect(page.getByTestId('workflows-dossier-vide')).toBeVisible();
    const id = etat.dossiers[0]!.id;

    await page.getByTestId(`dossier-onglet-tous`).click();
    await page.getByTestId(`workflow-menu-${W1}`).click();
    await page.getByTestId(`workflow-deplacer-${W1}`).click();
    await page.getByTestId(`dossier-vers-${id}`).click();
    await expect.poll(() => etat.rangement.scenario![W1]).toBe(id);
    await expect(page.getByTestId(`dossier-onglet-${id}`)).toContainText('1');
    await expect(page.getByTestId('dossier-onglet-sans')).toContainText('2');

    await page.getByTestId(`dossier-onglet-${id}`).click();
    await expect(page.getByText('Relance panier')).toBeVisible();
    await expect(page.getByText('Prise de rendez-vous')).toHaveCount(0);
  });

  test('🔴 « Déplacer vers… » range une sélection en masse, et « Sans dossier » la ressort', async ({ page }) => {
    const etat = await monter(page, ADMIN, { dossiers: [SAV] });
    await page.goto('/workflows');
    await page.getByTestId(`workflow-cocher-${W2}`).check();
    await page.getByTestId(`workflow-cocher-${W3}`).check();
    await page.getByTestId('workflows-deplacer-selection').click();
    await page.getByTestId(`dossier-vers-${SAV.id}`).click();
    await expect.poll(() => etat.rangement.scenario).toEqual({ [W2]: SAV.id, [W3]: SAV.id });
    const rangement = etat.appels.find((a) => a.method === 'PUT');
    expect(rangement?.body).toEqual({ type: 'scenario', cles: [W2, W3], dossierId: SAV.id });

    await page.getByTestId(`dossier-onglet-${SAV.id}`).click();
    await page.getByTestId('workflows-tout-cocher').check();
    await page.getByTestId('workflows-deplacer-selection').click();
    // Les deux sont déjà là : le dossier est désigné comme actuel.
    await expect(page.getByTestId(`dossier-vers-${SAV.id}`)).toContainText('actuel');
    await page.getByTestId('dossier-vers-sans').click();
    await expect.poll(() => etat.rangement.scenario).toEqual({});
  });

  test('🔴 renommer puis supprimer un dossier : la suppression confirme, et ses scénarios repassent « Sans dossier »', async ({ page }) => {
    const etat = await monter(page, ADMIN, { dossiers: [SAV], rangement: { scenario: { [W1]: SAV.id }, template: {} } });
    await page.goto('/workflows');
    await page.getByTestId(`dossier-onglet-${SAV.id}`).click();
    await page.getByTestId('dossier-menu').click();
    await page.getByTestId('dossier-renommer').click();
    await page.getByTestId('dossier-nom').fill('Support client');
    await page.getByTestId('dossier-enregistrer').click();
    await expect(page.getByTestId(`dossier-onglet-${SAV.id}`)).toContainText('Support client');

    await page.getByTestId('dossier-menu').click();
    await page.getByTestId('dossier-supprimer').click();
    await repondre(page, false, 'Sans dossier');
    expect(etat.appels.some((a) => a.method === 'DELETE')).toBe(false);
    await page.getByTestId('dossier-menu').click();
    await page.getByTestId('dossier-supprimer').click();
    await repondre(page, true);
    await expect.poll(() => etat.dossiers.length).toBe(0);
    // Retour à « Tous », et le scénario est toujours là.
    await expect(page.getByTestId('dossier-onglet-tous')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Relance panier')).toBeVisible();
  });

  test('la copie d’un scénario rangé reste dans son dossier', async ({ page }) => {
    const etat = await monter(page, ADMIN, { dossiers: [SAV], rangement: { scenario: { [W1]: SAV.id }, template: {} } });
    await page.goto('/workflows');
    await page.getByTestId(`workflow-menu-${W1}`).click();
    await page.getByRole('button', { name: 'Dupliquer' }).click();
    await expect.poll(() => etat.rangement.scenario!['copie-0000-4000-8000-000000000000']).toBe(SAV.id);
  });

  test('un nom déjà pris est dit, sans fermer la saisie', async ({ page }) => {
    await monter(page, ADMIN, { dossiers: [SAV] });
    await page.goto('/workflows');
    await page.getByTestId('dossier-creer').click();
    await page.getByTestId('dossier-nom').fill('sav');
    await page.getByTestId('dossier-enregistrer').click();
    await expect(page.getByTestId('dossier-erreur')).toContainText('déjà ce nom');
    await expect(page.getByTestId('dossier-nom')).toBeVisible();
  });

  test('🔴 une API sans la route des dossiers laisse la page telle qu’avant', async ({ page }) => {
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), ADMIN);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
      // Le 404 du routeur Fastify, tel qu'une API pas encore déployée le rend.
      if (url.includes('/dossiers')) return json({ message: 'Route GET:/x not found', error: 'Not Found', statusCode: 404 }, 404);
      if (url.endsWith('/workflows')) return json({ workflows: WFS });
      if (url.endsWith('/me')) return json({ email: ADMIN.email, name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/workflows');
    await expect(page.getByText('Relance panier')).toBeVisible();
    await expect(page.getByTestId('dossiers-scenario')).toHaveCount(0);
  });
});

test.describe('Dossiers : la page Templates', () => {
  test('🔴 un template à deux langues se range d’un geste, par son nom', async ({ page }) => {
    const etat = await monter(page, ADMIN, { dossiers: [PROMOS] });
    await page.goto('/templates');
    await expect(page.getByTestId('dossier-onglet-tous')).toContainText('3');
    // Cocher une langue coche le template entier.
    await page.getByTestId('template-cocher-promo_ete-fr').check();
    await expect(page.getByTestId('template-cocher-promo_ete-en_US')).toBeChecked();
    await page.getByTestId('templates-deplacer-selection').click();
    await page.getByTestId(`dossier-vers-${PROMOS.id}`).click();
    await expect.poll(() => etat.rangement.template).toEqual({ promo_ete: PROMOS.id });
    expect(etat.appels.find((a) => a.method === 'PUT')?.body).toEqual({ type: 'template', cles: ['promo_ete'], dossierId: PROMOS.id });
    await page.getByTestId(`dossier-onglet-${PROMOS.id}`).click();
    await expect(page.getByTestId(`dossier-onglet-${PROMOS.id}`)).toContainText('2');
    await expect(page.getByText('relance_panier')).toHaveCount(0);
  });

  test('« Déplacer vers… » sur une ligne, puis le template sort de son dossier', async ({ page }) => {
    const etat = await monter(page, ADMIN, { dossiers: [PROMOS], rangement: { scenario: {}, template: { relance_panier: PROMOS.id } } });
    await page.goto('/templates');
    await page.getByTestId('template-deplacer-relance_panier-fr').click();
    await expect(page.getByTestId(`dossier-vers-${PROMOS.id}`)).toContainText('actuel');
    await page.getByTestId('dossier-vers-sans').click();
    await expect.poll(() => etat.rangement.template).toEqual({});
  });

  test('supprimer un template rangé libère sa place dans le dossier', async ({ page }) => {
    const etat = await monter(page, ADMIN, { dossiers: [PROMOS], rangement: { scenario: {}, template: { relance_panier: PROMOS.id } } });
    await page.goto('/templates');
    await page.getByRole('row', { name: /relance_panier/ }).getByRole('button', { name: 'Supprimer' }).click();
    await repondre(page, true);
    await expect.poll(() => etat.appels.find((a) => a.method === 'PUT')?.body).toEqual({ type: 'template', cles: ['relance_panier'], dossierId: null });
  });

});
