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
  async function ouvrir(page: import('@playwright/test').Page, dealStages: unknown, portail?: boolean) {
    const posted: Array<Record<string, unknown>> = [];
    let appelsEtapes = 0;
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/hubspot/deal-stages')) { appelsEtapes += 1; return json(dealStages); }
      // Le lien du portail voyage avec les REGLAGES (lot 9) : `undefined` = API anterieure a ce lot.
      if (url.endsWith('/settings')) {
        return json({
          mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: true,
          controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {},
          ...(portail === undefined ? {} : { hubspotPortalConnecte: portail }),
        });
      }
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

  test('🔴 AUCUN portail lié : le déclencheur n’est même pas proposé', async ({ page }) => {
    /**
     * Arbitrage de Julien du 2026-09-23 : une intégration qu'on n'a pas est du bruit, pas une information.
     * Il était GRISÉ, et seulement APRÈS une première sélection (lire les étapes coûte un aller-retour
     * jusqu'à HubSpot). Le lien du portail, lui, est une lecture locale : on peut la payer à l'ouverture.
     */
    await ouvrir(page, { connected: false, pipelines: [] }, false);
    const menu = page.getByTestId('automation-trigger');
    await expect(menu.locator('option[value="hubspot_deal_stage"]')).toHaveCount(0);
    // Les autres déclencheurs restent : on masque UNE option, pas la liste.
    await expect(menu.locator('option[value="keyword"]')).toHaveCount(1);
  });

  test('🔴 portail lié : le déclencheur est proposé', async ({ page }) => {
    // La preuve inverse : sans elle, un masquage qui cacherait toujours l’option passerait le cas du dessus.
    await ouvrir(page, { connected: true, pipelines: PIPELINES }, true);
    await expect(page.getByTestId('automation-trigger').locator('option[value="hubspot_deal_stage"]')).toHaveCount(1);
  });

  test('portail non relié : on le dit, sans menu et sans erreur rouge', async ({ page }) => {
    await ouvrir(page, { connected: false, pipelines: [] });
    await page.getByTestId('automation-trigger').selectOption('hubspot_deal_stage');
    await expect(page.getByText(/Aucun portail HubSpot n’est relié/)).toBeVisible();
    await expect(page.getByTestId('automation-deal-stage')).toHaveCount(0);
  });
});

/**
 * Déclencheur « X avant une date du contact » (2026-08-23).
 *
 * Ce qu'il faut protéger ici : le menu ne doit proposer QUE des champs date et heure. Un champ texte
 * accepterait la configuration et ne partirait jamais, sans que rien ne le dise.
 */
test.describe('Automation : un délai avant une date', () => {
  const SESSION_B = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

  async function monter(page: import('@playwright/test').Page, champs: Array<{ key: string; label: string; type: string }>) {
    const posted: Array<Record<string, unknown>> = [];
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION_B);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.endsWith('/automations') && req.method() === 'POST') {
        posted.push(req.postDataJSON() as Record<string, unknown>);
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'a1' }) });
      }
      if (url.endsWith('/automations')) return json({ automations: [] });
      if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Rappel', graph: { nodes: [], edges: [] } }] });
      if (url.includes('/user-fields')) return json({ fields: champs });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/automations');
    await page.getByTestId('automation-add').click();
    await page.getByTestId('automation-trigger').selectOption('avant_date');
    return posted;
  }

  test('🔴 seuls les champs DATE ET HEURE sont proposés', async ({ page }) => {
    // Un champ texte accepterait la config et ne partirait jamais : l'automation aurait l'air réglée.
    await monter(page, [
      { key: 'rdv', label: 'Rendez-vous', type: 'datetime' },
      { key: 'ville', label: 'Ville', type: 'text' },
      { key: 'naissance', label: 'Naissance', type: 'date' },
    ]);
    const menu = page.getByTestId('avant-date-champ');
    await expect(menu).toContainText('Rendez-vous');
    await expect(menu).not.toContainText('Ville');
    await expect(menu).not.toContainText('Naissance');
  });

  test('🔴 sans aucun champ date et heure, l’écran DIT quoi faire', async ({ page }) => {
    // Un menu vide laisserait chercher ce qui manque.
    await monter(page, [{ key: 'ville', label: 'Ville', type: 'text' }]);
    await expect(page.getByTestId('avant-date-aucun-champ')).toContainText(/Champs|Fields/);
  });

  test('🔴 la configuration envoyée porte le champ, le délai et l’unité', async ({ page }) => {
    const posted = await monter(page, [{ key: 'rdv', label: 'Rendez-vous', type: 'datetime' }]);
    await page.getByTestId('automation-name').fill('Rappel 48 h avant');
    await page.getByTestId('avant-date-delai').fill('48');
    await page.getByTestId('avant-date-unite').selectOption('heures');
    await page.getByTestId('avant-date-champ').selectOption('rdv');
    await page.getByTestId('automation-workflow').selectOption('wf1');
    await page.getByTestId('automation-submit').click();
    await expect.poll(() => posted.length).toBeGreaterThan(0);
    expect(posted[0]).toMatchObject({
      triggerKind: 'avant_date',
      triggerConfig: { fieldKey: 'rdv', delai: 48, unite: 'heures' },
      enabled: false,
    });
  });

  test('🔴 le SENS part dans la configuration, et « avant » reste le défaut', async ({ page }) => {
    // Demande de Julien du 2026-09-08. Le défaut compte autant que le choix : les automations déjà en
    // production n'ont pas ce champ, elles valent « avant », et l'écran ne doit pas proposer autre chose
    // au départ, sinon on crée des rappels du mauvais côté sans que personne ne l'ait demandé.
    const posted = await monter(page, [{ key: 'rdv', label: 'Rendez-vous', type: 'datetime' }]);
    await expect(page.getByTestId('avant-date-sens')).toHaveValue('avant');

    await page.getByTestId('automation-name').fill('Relance 3 jours après');
    await page.getByTestId('avant-date-sens').selectOption('apres');
    await page.getByTestId('avant-date-delai').fill('3');
    await page.getByTestId('avant-date-unite').selectOption('jours');
    await page.getByTestId('avant-date-champ').selectOption('rdv');
    await page.getByTestId('automation-workflow').selectOption('wf1');
    await page.getByTestId('automation-submit').click();
    await expect.poll(() => posted.length).toBeGreaterThan(0);
    expect(posted[0]).toMatchObject({
      triggerKind: 'avant_date',
      triggerConfig: { fieldKey: 'rdv', delai: 3, unite: 'jours', sens: 'apres' },
    });
  });

  test('le déclencheur s’annonce « avant ou après », pas seulement « avant »', async ({ page }) => {
    await monter(page, [{ key: 'rdv', label: 'Rendez-vous', type: 'datetime' }]);
    await expect(page.getByTestId('automation-trigger')).toContainText(/avant ou après|before or after/);
  });

  test('sans champ choisi, l’enregistrement reste impossible', async ({ page }) => {
    await monter(page, [{ key: 'rdv', label: 'Rendez-vous', type: 'datetime' }]);
    await page.getByTestId('automation-name').fill('Incomplet');
    await page.getByTestId('automation-workflow').selectOption('wf1');
    await expect(page.getByTestId('automation-submit')).toBeDisabled();
  });
});

/**
 * Garde HubSpot : quand aucun portail n'est relié, le déclencheur « étape de deal » ne doit pas pouvoir
 * être retenu. Il l'était déjà (impossible de choisir une étape, donc impossible d'enregistrer), mais
 * l'option restait sélectionnable et le message renvoyait vers le mauvais écran.
 */
test.describe('Automation : HubSpot non connecté', () => {
  async function monter(page: import('@playwright/test').Page) {
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
      // La route répond 200 avec `connected: false` : ce n'est PAS une erreur HTTP. Une première version du
      // mock rendait 409, ce qui poussait l'écran dans l'état « erreur » et non « non connecté ».
      if (url.includes('/hubspot/deal-stages')) return json({ connected: false, pipelines: [] });
      if (url.endsWith('/automations')) return json({ automations: [] });
      if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Relance', graph: { nodes: [], edges: [] } }] });
      if (url.includes('/user-fields')) return json({ fields: [] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/automations');
    await page.getByTestId('automation-add').click();
  }

  test('🔴 le message renvoie vers l’ACCUEIL, là où la connexion se fait vraiment', async ({ page }) => {
    // Il disait « Paramètres », où il n'y a rien pour connecter HubSpot : on envoyait chercher au mauvais
    // endroit exactement au moment où l'utilisateur est bloqué.
    //
    // ⚠️ L'assertion est SCOPÉE au formulaire. Cherchée sur la page entière, elle matchait le lien
    // « Accueil » de la barre latérale et passait quel que soit le message.
    await monter(page);
    await page.getByTestId('automation-trigger').selectOption('hubspot_deal_stage');
    const bloc = page.getByTestId('automation-form');
    await expect(bloc).toContainText(/Accueil|Home page/);
    await expect(bloc).not.toContainText(/dans Paramètres|in Settings/);
  });

  test('🔴 une fois qu’on SAIT, l’option n’est plus sélectionnable', async ({ page }) => {
    await monter(page);
    await page.getByTestId('automation-trigger').selectOption('hubspot_deal_stage');
    await expect(page.getByTestId('automation-form')).toContainText(/Accueil|Home page/);
    const option = page.getByTestId('automation-trigger').locator('option[value="hubspot_deal_stage"]');
    await expect(option).toBeDisabled();
    await expect(option).toContainText(/non connecté|not connected/);
  });

  test('🔴 et l’enregistrement reste impossible', async ({ page }) => {
    await monter(page);
    await page.getByTestId('automation-name').fill('Deal gagné');
    await page.getByTestId('automation-trigger').selectOption('hubspot_deal_stage');
    await page.getByTestId('automation-workflow').selectOption('wf1');
    await expect(page.getByTestId('automation-submit')).toBeDisabled();
  });
});

/**
 * 🔴 Déclencheur « le contact arrive d'une publicité WhatsApp » (CTWA).
 *
 * Meta joint l'origine de la pub (`referral.source_id`) au PREMIER message envoyé après le clic, et à lui
 * seul. C'est ce qui permet de router un lead publicitaire vers un scénario d'accueil.
 *
 * La config VIDE veut dire « n'importe quelle pub », à l'INVERSE du déclencheur « tag ajouté » : c'est le
 * montage le plus courant, et il reste borné aux messages venus d'une pub.
 */
test.describe('Automation : déclencheur publicité (CTWA)', () => {
  async function monter(page: import('@playwright/test').Page, posted: Array<Record<string, unknown>>) {
    await page.addInitScript((sess) => window.localStorage.setItem('mba.session', JSON.stringify(sess)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.endsWith('/automations') && req.method() === 'POST') {
        posted.push(req.postDataJSON() as Record<string, unknown>);
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'a1' }) });
      }
      if (url.endsWith('/automations')) return json({ automations: [] });
      if (url.endsWith('/workflows')) return json({ workflows: [WF] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/automations');
    await page.getByTestId('automation-add').click();
    await page.getByTestId('automation-name').fill('Lead pub');
    await page.getByTestId('automation-trigger').selectOption('ctwa_ad');
  }

  test('🔴 sans identifiant, la config part VIDE : le scénario vaut pour toutes les pubs', async ({ page }) => {
    const posted: Array<Record<string, unknown>> = [];
    await monter(page, posted);
    await expect(page.getByTestId('config-ctwa-ad')).toBeVisible();
    await page.getByTestId('automation-workflow').selectOption('wf1');
    await page.getByTestId('automation-submit').click();

    await expect.poll(() => posted.length, { timeout: 10_000 }).toBe(1);
    expect(posted[0]).toMatchObject({ triggerKind: 'ctwa_ad', triggerConfig: {} });
  });

  test('avec un identifiant, il part dans la config', async ({ page }) => {
    const posted: Array<Record<string, unknown>> = [];
    await monter(page, posted);
    await page.getByTestId('automation-ad-id').fill('120212345678901234');
    await page.getByTestId('automation-workflow').selectOption('wf1');
    await page.getByTestId('automation-submit').click();

    await expect.poll(() => posted.length, { timeout: 10_000 }).toBe(1);
    expect(posted[0]).toMatchObject({ triggerKind: 'ctwa_ad', triggerConfig: { adId: '120212345678901234' } });
  });
});

/**
 * 🔴 Déclencheur « le risque de désengagement d'un contact devient élevé » (lot 7 de l'API publique).
 *
 * Il ne se règle pas, il se constate : la config part VIDE. Ce que l'écran doit dire AVANT la création, parce
 * que ce déclencheur vient d'un chemin de MASSE (le balayage de nuit) et peut lancer des scénarios facturés :
 * un passage et pas un état, 200 contacts au plus par nuit et par espace, rien pour un désabonné ou un bloqué,
 * et un scénario qui commence par un template.
 */
test.describe('Automation : déclencheur « risque élevé »', () => {
  async function monter(page: import('@playwright/test').Page, posted: Array<Record<string, unknown>>, listees: unknown[] = []) {
    await page.addInitScript((sess) => window.localStorage.setItem('mba.session', JSON.stringify(sess)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.endsWith('/automations') && req.method() === 'POST') {
        posted.push(req.postDataJSON() as Record<string, unknown>);
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'a1' }) });
      }
      if (url.endsWith('/automations')) return json({ automations: listees });
      if (url.endsWith('/workflows')) return json({ workflows: [WF] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/automations');
  }

  test('🔴 l’écran dit les bornes avant la création, et la config part VIDE', async ({ page }) => {
    const posted: Array<Record<string, unknown>> = [];
    await monter(page, posted);
    await page.getByTestId('automation-add').click();
    await page.getByTestId('automation-name').fill('Relance des partants');
    await page.getByTestId('automation-trigger').selectOption('risque_eleve');
    const explication = page.getByTestId('config-risque-eleve');
    await expect(explication).toContainText('PASSE en risque élevé');
    await expect(explication).toContainText('Au plus 200 contacts par nuit et par espace');
    await expect(explication).toContainText('désabonné ou bloqué ne déclenche rien');
    await expect(explication).toContainText('commencer par un envoi de template');
    await page.getByTestId('automation-workflow').selectOption('wf1');
    await page.getByTestId('automation-submit').click();

    await expect.poll(() => posted.length, { timeout: 10_000 }).toBe(1);
    expect(posted[0]).toMatchObject({ triggerKind: 'risque_eleve', triggerConfig: {}, enabled: false });
  });

  test('une automation existante se lit en clair dans la liste', async ({ page }) => {
    const listee = { id: 'a9', name: 'Relance', enabled: false, triggerKind: 'risque_eleve', triggerConfig: {}, conditionGroup: null, workflowId: 'wf1', startNodeId: null, cooldownSeconds: null };
    await monter(page, [], [listee]);
    await expect(page.getByText('le risque de désengagement d’un contact devient élevé')).toBeVisible();
  });
});
