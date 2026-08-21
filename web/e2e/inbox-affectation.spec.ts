import { test, expect } from '@playwright/test';

/**
 * Inbox : affecter une conversation à un membre de l'équipe.
 *
 * Règle : non affectée, tout le monde répond ; affectée, seul l'agent désigné ; manager et admin peuvent
 * toujours reprendre la main. Un agent non affecté VOIT la conversation et comprend pourquoi il ne peut pas
 * y répondre.
 *
 * ⚠️ Le refus réel est appliqué par le SERVEUR (`tests/http-inbox.test.ts`). Ces tests-ci vérifient que
 * l'écran dit la vérité : ne pas afficher une zone de saisie qui mènerait à un refus, et ne pas proposer
 * d'affecter à qui n'en a pas le droit.
 */
const conv = (over: Record<string, unknown> = {}) => ({
  id: 'c1', waId: '33600000001', profileName: 'Alice Martin', lastPreview: 'coucou',
  lastMessageAt: '2026-08-21T10:00:00Z', controlOwner: 'app_workflow', unread: false,
  assignedTo: null, assignedToName: null, assignedToMe: false, ...over,
});

async function mock(
  page: import('@playwright/test').Page,
  opts: { role: string; conversation?: Record<string, unknown> } ,
) {
  const patches: Array<Record<string, unknown>> = [];
  const session = { token: 'e2e-token', email: 'moi@e2e.test', role: opts.role, tenantId: 't-e2e' };
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), session);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const chemin = url.split('?')[0]!;
    const method = route.request().method();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/assignee')) {
      patches.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>);
      return json({ conversationId: 'c1', assignee: null });
    }
    if (chemin.endsWith('/conversations/todo-count')) return json({ count: 0 });
    if (chemin.endsWith('/conversations')) return json({ conversations: [opts.conversation ?? conv()] });
    if (chemin.endsWith('/c1/messages')) {
      return json({ waId: '33600000001', windowOpen: true, lastInboundAt: '2026-08-21T10:00:00Z', controlOwner: 'app_workflow', messages: [] });
    }
    if (chemin.endsWith('/users')) {
      return json({ users: [{ id: 'u-agent', name: 'Bob Agent', email: 'bob@e2e.test', role: 'agent' }] });
    }
    if (chemin.endsWith('/me')) return json({ email: 'moi@e2e.test', name: 'Moi', role: opts.role });
    if (method === 'POST') return json({ messageId: 'wamid.1' });
    return json({});
  });
  return patches;
}

/** Ouvre la conversation (la vignette, pas le nom qui ouvre la fiche). */
async function ouvrir(page: import('@playwright/test').Page) {
  await page.goto('/inbox');
  await page.getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).click();
}

test.describe('Inbox : affectation', () => {
  test('un manager voit un sélecteur et peut affecter', async ({ page }) => {
    const patches = await mock(page, { role: 'manager' });
    await ouvrir(page);
    const select = page.getByTestId('assignment-select');
    await expect(select).toBeVisible();
    await select.selectOption('u-agent');
    await expect.poll(() => patches.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(patches[0]).toEqual({ assignee: 'u-agent' });
  });

  test('🔴 un AGENT n’a pas le sélecteur : il ne distribue pas le travail', async ({ page }) => {
    await mock(page, { role: 'agent' });
    await ouvrir(page);
    await expect(page.getByTestId('assignment-select')).toHaveCount(0);
  });

  test('non affectée : un agent peut répondre', async ({ page }) => {
    await mock(page, { role: 'agent' });
    await ouvrir(page);
    await expect(page.getByPlaceholder(/Répondre|Reply/)).toBeVisible();
    await expect(page.getByTestId('assigned-elsewhere')).toHaveCount(0);
  });

  test('🔴 affectée à UN AUTRE : l’agent voit la conversation mais pas la zone de réponse', async ({ page }) => {
    // Le point de la règle : il VOIT (la conversation reste listée et lisible), il ne peut pas répondre, et
    // il sait qui la suit. Laisser la zone de saisie mènerait à écrire un message refusé par le serveur.
    await mock(page, { role: 'agent', conversation: conv({ assignedTo: 'u-autre', assignedToName: 'Bob Agent', assignedToMe: false }) });
    await ouvrir(page);
    await expect(page.getByTestId('assigned-elsewhere')).toContainText('Bob Agent');
    await expect(page.getByPlaceholder(/Répondre|Reply/)).toHaveCount(0);
  });

  test('affectée à MOI : l’agent répond normalement', async ({ page }) => {
    await mock(page, { role: 'agent', conversation: conv({ assignedTo: 'u-moi', assignedToName: 'Moi', assignedToMe: true }) });
    await ouvrir(page);
    await expect(page.getByPlaceholder(/Répondre|Reply/)).toBeVisible();
    await expect(page.getByTestId('assignment-badge')).toContainText(/pour moi|assigned to me/);
  });

  test('🔴 un MANAGER garde la main sur une conversation affectée à un autre', async ({ page }) => {
    await mock(page, { role: 'manager', conversation: conv({ assignedTo: 'u-autre', assignedToName: 'Bob Agent' }) });
    await ouvrir(page);
    await expect(page.getByPlaceholder(/Répondre|Reply/)).toBeVisible();
    await expect(page.getByTestId('assigned-elsewhere')).toHaveCount(0);
  });

  test('🔴 un serveur qui ne connaît pas l’affectation ne ferme la réponse à personne', async ({ page }) => {
    // Champs absents (instance antérieure) : on ne doit fermer que sur une affectation explicitement connue.
    const sansChamps = { id: 'c1', waId: '33600000001', profileName: 'Alice Martin', lastPreview: 'coucou', lastMessageAt: '2026-08-21T10:00:00Z', controlOwner: 'app_workflow' };
    await mock(page, { role: 'agent', conversation: sansChamps });
    await ouvrir(page);
    await expect(page.getByPlaceholder(/Répondre|Reply/)).toBeVisible();
  });
});
