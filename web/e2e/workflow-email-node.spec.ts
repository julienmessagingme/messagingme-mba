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
    if (url.includes('/user-fields')) return json({ fields: [{ key: 'email', label: 'Email', type: 'text' }] });
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
    await page.getByTestId('email-recipient-value').fill('client@exemple.fr');

    await expect.poll(
      () => saved.some((g) => g.nodes.some((n) =>
        n.type === 'email'
        && (n.data as { emailAccountId?: string }).emailAccountId === 'a1'
        && (n.data as { templateId?: string }).templateId === 'tpl1'
        && JSON.stringify((n.data as { to?: unknown }).to) === JSON.stringify({ kind: 'literal', value: 'client@exemple.fr' }))),
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
    await expect(page.getByTestId('email-recipient-kind-field')).toBeVisible();

    await page.getByTestId('email-recipient-kind-field').click();
    await page.getByTestId('email-recipient-field').selectOption('email');

    await expect.poll(
      () => saved.some((g) => g.nodes.some((n) =>
        n.type === 'email' && JSON.stringify((n.data as { to?: unknown }).to) === JSON.stringify({ kind: 'field', field: 'email' }))),
      { timeout: 10_000 },
    ).toBe(true);
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
