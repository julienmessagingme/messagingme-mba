import { test, expect } from '@playwright/test';

/**
 * E2E Automation (Lot E) : créer une automation « mot-clé » depuis l'écran, et vérifier qu'elle part
 * DÉSACTIVÉE (une automation écrit au client sans relecture humaine : elle ne s'allume jamais toute seule).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const WF = { id: 'wf1', name: 'Prise de RDV', graph: { nodes: [], edges: [] } };

test.describe('Automation : création d’un déclencheur mot-clé', () => {
  test('crée une automation désactivée avec ses mots-clés, puis l’active', async ({ page }) => {
    const posted: Array<Record<string, unknown>> = [];
    const patched: Array<Record<string, unknown>> = [];
    let listed: Array<Record<string, unknown>> = [];

    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.endsWith('/automations') && req.method() === 'POST') {
        const body = req.postDataJSON() as Record<string, unknown>;
        posted.push(body);
        listed = [{ id: 'a1', ...body, conditionGroup: null, startNodeId: null, cooldownSeconds: null }];
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'a1' }) });
      }
      if (/\/automations\/a1$/.test(url) && req.method() === 'PATCH') {
        const body = req.postDataJSON() as Record<string, unknown>;
        patched.push(body);
        return json({ id: 'a1' });
      }
      if (url.endsWith('/automations')) return json({ automations: listed });
      if (url.endsWith('/workflows')) return json({ workflows: [WF] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await page.goto('/automations');

    await page.getByTestId('automation-add').click();
    await page.getByTestId('automation-name').fill('Demande de RDV');
    await page.getByTestId('automation-keywords').fill('rdv, rendez-vous');
    await page.getByTestId('automation-workflow').selectOption('wf1');
    await page.getByTestId('automation-submit').click();

    // Créée DÉSACTIVÉE, avec les mots-clés découpés et nettoyés.
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toMatchObject({
      name: 'Demande de RDV',
      triggerKind: 'keyword',
      triggerConfig: { keywords: ['rdv', 'rendez-vous'], mode: 'contains' },
      workflowId: 'wf1',
      enabled: false,
    });

    // Elle apparaît dans la liste, désactivée, et le clic l'active.
    const toggle = page.getByTestId('automation-toggle-a1');
    await expect(toggle).toHaveText(/désactivée/);
    await toggle.click();
    await expect.poll(() => patched.length).toBe(1);
    expect(patched[0]).toEqual({ enabled: true });
  });
});

/**
 * Déclencheur « étape de deal HubSpot » : le menu doit rendre les LIBELLÉS du portail, et poster les deux
 * identifiants (le serveur exige le pipeline en plus de l'étape) plus le libellé, gardé pour l'affichage.
 */
const PIPELINES = [
  { id: 'default', label: 'Pipeline de vente', stages: [{ id: 'rdv', label: 'Rendez-vous', closed: false }, { id: 'won', label: 'Gagné', closed: true }] },
  { id: 'renew', label: 'Renouvellement', stages: [{ id: 'relance', label: 'À relancer', closed: false }] },
];

test.describe('Automation : déclencheur « étape de deal HubSpot »', () => {
  async function ouvrir(page: import('@playwright/test').Page, dealStages: unknown) {
    const posted: Array<Record<string, unknown>> = [];
    let appelsEtapes = 0;
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/hubspot/deal-stages')) { appelsEtapes += 1; return json(dealStages); }
      if (url.endsWith('/automations') && req.method() === 'POST') {
        posted.push(req.postDataJSON() as Record<string, unknown>);
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'a2' }) });
      }
      if (url.endsWith('/automations')) return json({ automations: [] });
      if (url.endsWith('/workflows')) return json({ workflows: [WF] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/automations');
    await page.getByTestId('automation-add').click();
    return { posted, nbAppelsEtapes: () => appelsEtapes };
  }

  test('choisit une étape par son libellé et poste pipeline + étape + libellé', async ({ page }) => {
    const { posted, nbAppelsEtapes } = await ouvrir(page, { connected: true, pipelines: PIPELINES });

    // Les étapes ne sont PAS lues tant qu'on n'a pas choisi ce déclencheur (elles coûtent un appel HubSpot).
    expect(nbAppelsEtapes()).toBe(0);
    await page.getByTestId('automation-trigger').selectOption('hubspot_deal_stage');

    const menu = page.getByTestId('automation-deal-stage');
    await expect(menu).toBeVisible();
    await expect.poll(() => nbAppelsEtapes()).toBe(1);
    // Groupé par pipeline, et les étapes de fin sont signalées.
    await expect(menu.locator('optgroup')).toHaveCount(2);
    await expect(menu.locator('option', { hasText: 'Gagné' })).toHaveText(/étape de fin/);

    await page.getByTestId('automation-name').fill('Devis envoyé');
    await menu.selectOption('default::rdv');
    await page.getByTestId('automation-workflow').selectOption('wf1');
    await page.getByTestId('automation-submit').click();

    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toMatchObject({
      triggerKind: 'hubspot_deal_stage',
      // Le pipeline accompagne l'étape : le serveur l'exige. Le libellé n'est que décoratif.
      triggerConfig: { pipelineId: 'default', stageId: 'rdv', stageLabel: 'Rendez-vous' },
      enabled: false,
    });
  });

  test('sans étape choisie, la création reste impossible', async ({ page }) => {
    await ouvrir(page, { connected: true, pipelines: PIPELINES });
    await page.getByTestId('automation-trigger').selectOption('hubspot_deal_stage');
    await page.getByTestId('automation-name').fill('Incomplète');
    await page.getByTestId('automation-workflow').selectOption('wf1');
    // Une automation sans étape partirait sur TOUS les changements du portail : le bouton doit rester mort.
    await expect(page.getByTestId('automation-submit')).toBeDisabled();
  });

  test('portail non relié : on le dit, sans menu et sans erreur rouge', async ({ page }) => {
    await ouvrir(page, { connected: false, pipelines: [] });
    await page.getByTestId('automation-trigger').selectOption('hubspot_deal_stage');
    await expect(page.getByText(/Aucun portail HubSpot n’est relié/)).toBeVisible();
    await expect(page.getByTestId('automation-deal-stage')).toHaveCount(0);
  });
});
