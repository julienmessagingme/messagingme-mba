import { test, expect } from '@playwright/test';

/**
 * E2E builder : le bloc « Action » s'ajoute (par défaut « ajouter un tag »), on change la sous-action, et
 * l'auto-save persiste un node `type:'action'` avec le bon `actionKind`.
 * Backend intercepté, aucune base (pattern des E2E accueil / condition).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

/** Ouvre le builder sur un scénario d'un seul template, et rend les graphes que l'auto-save envoie. */
async function ouvrirBuilder(page: import('@playwright/test').Page) {
  const saved: Graph[] = [];
  const initial: Graph = { nodes: [{ id: 't', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } }], edges: [] };
  const wf = { id: 'wf1', name: 'Scénario E2E', graph: initial, createdAt: '', updatedAt: '' };

  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
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
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });

  await page.goto('/workflows?open=wf1');
  // Ajoute un bloc Action (sélectionné à la création).
  await page.getByTestId('add-node-action').click();
  return { saved };
}

/** Un graphe enregistré porte-t-il un bloc action avec ce `actionKind` (et éventuellement ce tag) ? */
const persiste = (saved: Graph[], kind: string, tag?: string): boolean =>
  saved.some((g) => g.nodes.some((nd) => nd.type === 'action'
    && (nd.data as { actionKind?: unknown }).actionKind === kind
    && (tag === undefined || (nd.data as { tag?: unknown }).tag === tag)));

test.describe('Builder : node Action', () => {
  test('ajoute un bloc Action, choisit « retirer un tag », et l’auto-save persiste type:action + actionKind', async ({ page }) => {
    const { saved } = await ouvrirBuilder(page);

    // Le sélecteur de sous-action est là (par défaut « ajouter un tag ») : on passe à « retirer un tag ».
    await page.locator('select:has(option[value="remove_tag"])').selectOption('remove_tag');
    await page.getByPlaceholder('vip, prospect…').fill('vip');

    // L'auto-save persiste un node action « retirer le tag vip ».
    await expect.poll(() => persiste(saved, 'remove_tag', 'vip'), { timeout: 10_000 }).toBe(true);
  });

  test('🔴 la sous-action « passer en opt-out » se choisit et se persiste, sans rien à saisir', async ({ page }) => {
    // Le seul chemin capable de poser un opt-out AUTOMATIQUEMENT : l'upsert d'import ne fait jamais régresser
    // un statut, et la bascule à la main suppose un opérateur. C'est ce qu'on branche derrière un « STOP ».
    const { saved } = await ouvrirBuilder(page);
    await page.getByTestId('action-kind').selectOption('set_optout');

    // Aucun champ annexe : le sens est dans le choix de l'action. Le bloc est donc complet immédiatement.
    await expect(page.getByPlaceholder('vip, prospect…')).toHaveCount(0);
    await expect.poll(() => persiste(saved, 'set_optout'), { timeout: 10_000 }).toBe(true);
  });

  test('« passer en opt-in » se persiste aussi, et annonce ce qu’elle fait', async ({ page }) => {
    const { saved } = await ouvrirBuilder(page);
    await page.getByTestId('action-kind').selectOption('set_optin');
    await expect(page.getByText(/destinataire des campagnes marketing/)).toBeVisible();
    await expect.poll(() => persiste(saved, 'set_optin'), { timeout: 10_000 }).toBe(true);
  });
});
