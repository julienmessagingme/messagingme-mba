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
  opts: { role: string; conversation?: Record<string, unknown>; peutPrendre?: boolean; priseRefusee?: boolean } ,
) {
  const patches: Array<Record<string, unknown>> = [];
  const prises: string[] = [];
  const session = { token: 'e2e-token', email: 'moi@e2e.test', role: opts.role, tenantId: 't-e2e' };
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), session);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const chemin = url.split('?')[0]!;
    const method = route.request().method();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    // La PRISE par un agent (migration 0160). Aucun corps : l'affectataire est la session.
    if (chemin.endsWith('/assignee/moi') && method === 'POST') {
      prises.push(chemin);
      return opts.priseRefusee
        ? json({ error: 'Un collègue s’occupe déjà de cette conversation.', code: 'deja_prise' }, 409)
        : json({ conversationId: 'c1', assignee: 'u-moi' });
    }
    if (chemin.endsWith('/assignee')) {
      patches.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>);
      return json({ conversationId: 'c1', assignee: null });
    }
    if (chemin.endsWith('/conversations/todo-count')) return json({ count: 0 });
    if (chemin.endsWith('/conversations')) return json({ conversations: [opts.conversation ?? conv()], peutPrendre: opts.peutPrendre === true });
    if (chemin.endsWith('/c1/messages')) {
      return json({ waId: '33600000001', windowOpen: true, lastInboundAt: '2026-08-21T10:00:00Z', controlOwner: 'app_workflow', messages: [] });
    }
    /**
     * 🔴 `GET /users` EST RÉSERVÉ AUX ADMINS, ET CE FAUX LE SERVAIT À TOUT LE MONDE. C'est ce qui a caché que
     * le sélecteur d'un MANAGER revenait vide en production : le test « un manager voit un sélecteur et peut
     * affecter » passait sur un câblage que le vrai serveur refuse. Le faux refuse désormais comme le vrai,
     * et le sélecteur lit la route qui lui est ouverte.
     */
    if (chemin.endsWith('/users')) {
      return opts.role === 'admin'
        ? json({ users: [{ id: 'u-agent', name: 'Bob Agent', email: 'bob@e2e.test', role: 'agent' }] })
        : json({ error: 'action réservée aux administrateurs' }, 403);
    }
    if (chemin.endsWith('/conversations/membres-affectables')) {
      return opts.role === 'agent'
        ? json({ error: 'réservé aux managers et aux admins' }, 403)
        : json({ membres: [{ id: 'u-agent', nom: 'Bob Agent' }] });
    }
    if (chemin.endsWith('/me')) return json({ email: 'moi@e2e.test', name: 'Moi', role: opts.role });
    if (method === 'POST') return json({ messageId: 'wamid.1' });
    return json({});
  });
  return Object.assign(patches, { prises });
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

  test('🔴 réglage activé : un agent PREND une conversation du pot commun', async ({ page }) => {
    // L'arbitrage de Julien du 2026-09-19 : prendre, jamais réaffecter. Le bouton, et rien d'autre.
    const appels = await mock(page, { role: 'agent', peutPrendre: true });
    await ouvrir(page);
    await expect(page.getByTestId('assignment-select')).toHaveCount(0);
    await page.getByTestId('prendre-conversation').click();
    await expect.poll(() => appels.prises.length, { timeout: 10_000 }).toBe(1);
    // Et AUCUNE affectation par la route de l'encadrement : la prise passe par la sienne, qui ne porte pas
    // d'affectataire, donc l'agent ne peut désigner personne d'autre que lui.
    expect(appels).toHaveLength(0);
  });

  test('🔴 réglage coupé : aucun bouton, c’est le comportement d’avant', async ({ page }) => {
    await mock(page, { role: 'agent', peutPrendre: false });
    await ouvrir(page);
    await expect(page.getByPlaceholder(/Répondre|Reply/)).toBeVisible();
    await expect(page.getByTestId('prendre-conversation')).toHaveCount(0);
  });

  test('🔴 jamais sur la conversation d’un collègue, même réglage activé', async ({ page }) => {
    await mock(page, { role: 'agent', peutPrendre: true, conversation: conv({ assignedTo: 'u-autre', assignedToName: 'Bob Agent' }) });
    await ouvrir(page);
    await expect(page.getByTestId('prendre-conversation')).toHaveCount(0);
  });

  test('un collègue a été plus rapide : l’écran le dit', async ({ page }) => {
    await mock(page, { role: 'agent', peutPrendre: true, priseRefusee: true });
    await ouvrir(page);
    await page.getByTestId('prendre-conversation').click();
    await expect(page.getByTestId('prendre-refus')).toContainText('collègue');
  });

  test('🔴 un serveur qui ne connaît pas l’affectation ne ferme la réponse à personne', async ({ page }) => {
    // Champs absents (instance antérieure) : on ne doit fermer que sur une affectation explicitement connue.
    const sansChamps = { id: 'c1', waId: '33600000001', profileName: 'Alice Martin', lastPreview: 'coucou', lastMessageAt: '2026-08-21T10:00:00Z', controlOwner: 'app_workflow' };
    await mock(page, { role: 'agent', conversation: sansChamps });
    await ouvrir(page);
    await expect(page.getByPlaceholder(/Répondre|Reply/)).toBeVisible();
  });
});
