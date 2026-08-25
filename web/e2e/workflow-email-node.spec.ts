import { test, expect } from '@playwright/test';

/**
 * Bloc « Envoi de mail » dans le builder : grisé sans boîte SMTP connectée (`emailEnabled`, dérivé de
 * `listEmailAccounts` dans workflows/page.tsx), actif dès qu'une boîte existe, se configure (boîte, modèle,
 * destinataire en adresse fixe OU variable), et l'auto-save persiste sa config. Backend intercepté, aucune
 * base (même pattern que workflow-rcs-node.spec.ts).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

async function mockBuilder(
  page: import('@playwright/test').Page,
  initial: Graph,
  saved: Graph[],
  opts: { accounts?: Array<Record<string, unknown>>; templates?: Array<Record<string, unknown>> } = {},
) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  const wf = { id: 'wf1', name: 'Scénario E2E', graph: initial, createdAt: '', updatedAt: '' };
  const accounts = opts.accounts ?? [];
  const templates = opts.templates ?? [];
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'PATCH' && /\/workflows\/wf1$/.test(url)) {
      const body = (req.postDataJSON() ?? {}) as { graph?: Graph };
      if (body.graph) saved.push(body.graph);
      return json({ ok: true });
    }
    if (/\/workflows\/wf1$/.test(url)) return json({ workflow: wf });
    if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Scénario E2E', graph: initial }] });
    // ⚠️ `/email/templates` et `/email/accounts` contiennent `/templates` : les exclure du mock générique WhatsApp.
    if (url.includes('/email/accounts')) return json({ accounts });
    if (url.includes('/email/templates')) return json({ templates });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    // ⚠️ AVANT le mock générique : `/user-fields/usage` contient `/user-fields`. Sans cet ordre, le relévé
    // recevrait `{ fields: [] }` et le sélecteur afficherait « 0/undefined ».
    if (url.includes('/user-fields/usage')) return json({ total: 40, parChamp: { email: 12, mail: 0 } });
    if (url.includes('/user-fields')) return json({ fields: [{ key: 'email', label: 'Email', type: 'text' }, { key: 'mail', label: 'Mail', type: 'text' }] });
    if (url.includes('/settings')) return json({ mbaEnabled: false, rcsEnabled: false, hubspotListsEnabled: false, campaignsPaused: false });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

const ACCOUNT = { id: 'a1', label: 'Support', host: 'h', port: 465, secure: true, username: 'u', fromAddress: 'a@b.fr', fromName: null, replyTo: null, verifiedAt: null, createdAt: '', hasPassword: true };
const TEMPLATE = { id: 'tpl1', name: 'Confirmation', format: 'basic', subject: 'S', body: 'B', createdAt: '', updatedAt: '' };

test.describe('Builder : bloc Envoi de mail', () => {
  test('sans boîte connectée, le bloc email est visible mais grisé', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(
      page,
      { nodes: [{ id: 't', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } }], edges: [] },
      saved,
      { accounts: [] },
    );

    await page.goto('/workflows?open=wf1');

    const brique = page.getByTestId('add-node-email');
    await expect(brique).toBeVisible();
    await expect(brique).toBeDisabled();
    // Les briques normales, elles, restent utilisables.
    await expect(page.getByTestId('add-node-template')).toBeEnabled();
  });

  test('avec une boîte connectée, le bloc se crée depuis la palette et se configure (adresse fixe)', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(
      page,
      { nodes: [{ id: 't', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } }], edges: [] },
      saved,
      { accounts: [ACCOUNT], templates: [TEMPLATE] },
    );

    await page.goto('/workflows?open=wf1');

    const brique = page.getByTestId('add-node-email');
    await expect(brique).toBeEnabled();
    await brique.click();

    await page.getByTestId('email-account-select').selectOption('a1');
    await page.getByTestId('email-template-select').selectOption('tpl1');
    await page.getByTestId('email-recipient-value-0').fill('client@exemple.fr');

    await expect.poll(
      () => saved.some((g) => g.nodes.some((n) =>
        n.type === 'email'
        && (n.data as { emailAccountId?: string }).emailAccountId === 'a1'
        && (n.data as { templateId?: string }).templateId === 'tpl1'
        && JSON.stringify((n.data as { to?: unknown }).to) === JSON.stringify([{ kind: 'literal', value: 'client@exemple.fr' }]))),
      { timeout: 10_000 },
    ).toBe(true);
  });

  test('mode variable : le destinataire se choisit parmi les champs du contact et se persiste', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(
      page,
      {
        nodes: [{ id: 'e', type: 'email', position: { x: 0, y: 0 }, data: { emailAccountId: 'a1', templateId: 'tpl1', to: { kind: 'literal', value: '' } } }],
        edges: [],
      },
      saved,
      { accounts: [ACCOUNT], templates: [TEMPLATE] },
    );

    await page.goto('/workflows?open=wf1');

    // Sélectionne le bloc pré-existant sur le canevas (un seul node ici).
    await page.locator('.react-flow__node').first().click();
    await expect(page.getByTestId('email-recipient-kind-field-0')).toBeVisible();

    await page.getByTestId('email-recipient-kind-field-0').click();
    await page.getByTestId('email-recipient-field-0').selectOption('email');

    await expect.poll(
      () => saved.some((g) => g.nodes.some((n) =>
        n.type === 'email' && JSON.stringify((n.data as { to?: unknown }).to) === JSON.stringify([{ kind: 'field', field: 'email' }]))),
      { timeout: 10_000 },
    ).toBe(true);
  });

  test('jusqu’à 3 destinataires : le bouton « + » disparaît au 3e, et chaque ligne se retire', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(
      page,
      { nodes: [{ id: 'e', type: 'email', position: { x: 0, y: 0 }, data: { emailAccountId: 'a1', templateId: 'tpl1', to: [{ kind: 'literal', value: 'un@ex.fr' }] } }], edges: [] },
      saved,
      { accounts: [ACCOUNT], templates: [TEMPLATE] },
    );
    await page.goto('/workflows?open=wf1');
    await page.locator('.react-flow__node').first().click();

    // Une seule ligne au départ, et elle n’est PAS supprimable (elle porte le « À »).
    await expect(page.getByTestId('email-recipient-row-0')).toBeVisible();
    await expect(page.getByTestId('email-recipient-remove-0')).toHaveCount(0);

    await page.getByTestId('email-recipient-add').click();
    await page.getByTestId('email-recipient-add').click();
    await expect(page.getByTestId('email-recipient-row-2')).toBeVisible();
    // Au 3e, le bouton d’ajout disparaît : le plafond est le même que celui du serveur.
    await expect(page.getByTestId('email-recipient-add')).toHaveCount(0);

    // Le 1er annonce que les suivants sont en copie cachée : sans ça, on croit que tout le monde se voit.
    await expect(page.getByTestId('email-recipient-row-0')).toContainText(/copie cachée/i);

    await page.getByTestId('email-recipient-remove-2').click();
    await expect(page.getByTestId('email-recipient-row-2')).toHaveCount(0);
    await expect(page.getByTestId('email-recipient-add')).toBeVisible();
  });

  test('changer le mode d’une ligne n’efface PAS les autres', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(
      page,
      { nodes: [{ id: 'e', type: 'email', position: { x: 0, y: 0 }, data: { emailAccountId: 'a1', templateId: 'tpl1', to: [{ kind: 'literal', value: 'garde@ex.fr' }, { kind: 'literal', value: 'deux@ex.fr' }] } }], edges: [] },
      saved,
      { accounts: [ACCOUNT], templates: [TEMPLATE] },
    );
    await page.goto('/workflows?open=wf1');
    await page.locator('.react-flow__node').first().click();

    // Le basculement était GLOBAL avant : passer la 2e en variable remettait les deux à zéro.
    await page.getByTestId('email-recipient-kind-field-1').click();
    await page.getByTestId('email-recipient-field-1').selectOption('email');

    await expect(page.getByTestId('email-recipient-value-0')).toHaveValue('garde@ex.fr');
    await expect.poll(
      () => saved.some((g) => g.nodes.some((n) =>
        JSON.stringify((n.data as { to?: unknown }).to) === JSON.stringify([{ kind: 'literal', value: 'garde@ex.fr' }, { kind: 'field', field: 'email' }]))),
      { timeout: 10_000 },
    ).toBe(true);
  });

  test('🔴 un bloc à l’ANCIENNE forme (objet) s’ouvre normalement et reste envoyable', async ({ page }) => {
    // Les scénarios enregistrés avant le 2026-08-25 portent `to` comme un objet. Ne lire que la forme liste
    // afficherait un panneau vide et un résumé « configurer l’envoi » sur un bloc qui envoie parfaitement.
    const saved: Graph[] = [];
    await mockBuilder(
      page,
      { nodes: [{ id: 'e', type: 'email', position: { x: 0, y: 0 }, data: { emailAccountId: 'a1', templateId: 'tpl1', to: { kind: 'literal', value: 'ancien@ex.fr' } } }], edges: [] },
      saved,
      { accounts: [ACCOUNT], templates: [TEMPLATE] },
    );
    await page.goto('/workflows?open=wf1');

    // Le résumé du canevas le montre configuré, pas à configurer.
    await expect(page.locator('.react-flow__node').getByText('ancien@ex.fr')).toBeVisible();

    await page.locator('.react-flow__node').first().click();
    await expect(page.getByTestId('email-recipient-value-0')).toHaveValue('ancien@ex.fr');
  });

  test('sans modèle ni boîte choisis, le résumé du bloc invite à le configurer', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(
      page,
      { nodes: [{ id: 't', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } }], edges: [] },
      saved,
      { accounts: [ACCOUNT], templates: [TEMPLATE] },
    );

    await page.goto('/workflows?open=wf1');
    await page.getByTestId('add-node-email').click();

    await expect(page.locator('.react-flow__node').getByText(/configurer l.envoi/i)).toBeVisible();
  });
});

/**
 * 🔴 Le sélecteur de destinataire dit COMBIEN de fiches ont ce champ rempli.
 *
 * Le 2026-08-25, un bloc mail a été branché sur « Mail » (vide sur toutes les fiches) alors que l'adresse
 * vivait dans « Email ». Deux champs voisins, présentés à l'identique. Aucun mail n'est parti, et rien ne
 * l'a dit. Le nombre de fiches concernées est ce qui distingue les deux d'un coup d'œil.
 */
test.describe('Bloc mail : le sélecteur de destinataire montre les fiches remplies', () => {
  test('chaque champ affiche « rempli / total », et un champ vide partout affiche 0', async ({ page }) => {
    await mockBuilder(
      page,
      { nodes: [{ id: 'e', type: 'email', position: { x: 0, y: 0 }, data: { emailAccountId: 'a1', templateId: 'tpl1', to: { kind: 'literal', value: '' } } }], edges: [] },
      [],
      { accounts: [ACCOUNT], templates: [TEMPLATE] },
    );
    await page.goto('/workflows?open=wf1');
    await page.locator('.react-flow__node').first().click();

    await page.getByTestId('email-recipient-kind-field-0').click();
    const options = page.getByTestId('email-recipient-field-0').locator('option');
    // ⚠️ Motifs ANCRÉS : « Mail » est contenu dans « Email », un filtre par sous-chaîne attrape les deux et
    // le test passerait en ne regardant jamais la bonne option.
    await expect(options.filter({ hasText: /^Email /u }).first()).toHaveText(/12\/40/);
    await expect(options.filter({ hasText: /^Mail /u }).first()).toHaveText(/0\/40/);
  });
});
