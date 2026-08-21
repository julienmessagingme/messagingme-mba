import { test, expect } from '@playwright/test';

/**
 * E2E : lancer un SCÉNARIO depuis l'Inbox. La règle métier est portée par la fenêtre de service de 24 h :
 * ouverte, tous les scénarios ; fermée, uniquement ceux qui OUVRENT par un template configuré (un tag, une
 * action ou une condition avant lui ne posent aucun problème). Backend intercepté, pattern des autres specs.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONVERSATIONS = [
  { id: 'c1', waId: '33600000001', profileName: 'Alice', lastPreview: 'coucou', lastMessageAt: '2026-08-15T11:00:00Z', controlOwner: 'app_human', unread: false },
];

/** Ouvre par un template : éligible même hors fenêtre. Le tag devant ne change rien. */
const WF_TEMPLATE = {
  id: 'wf-tpl', name: 'Relance promo', graph: {
    nodes: [
      { id: 'tg', type: 'tag', position: { x: 0, y: 0 }, data: { tag: 'relance' } },
      { id: 'n1', type: 'template', position: { x: 200, y: 0 }, data: { templateName: 'promo', language: 'fr' } },
    ],
    edges: [{ id: 'e1', source: 'tg', target: 'n1' }],
  },
};
/** Ouvre par un message rapide : possible SEULEMENT en fenêtre ouverte. */
const WF_SESSION = {
  id: 'wf-qm', name: 'Questionnaire à chaud', graph: {
    nodes: [{ id: 'n1', type: 'quick_message', position: { x: 0, y: 0 }, data: { body: 'Ça te va ?', quickReplies: ['Oui', 'Non'] } }],
    edges: [],
  },
};

async function mock(page: import('@playwright/test').Page, windowOpen: boolean, lances: string[], refus?: string) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/conversations/unread-count')) return json({ count: 0 });
    if (/\/conversations\/[^/]+\/workflow$/.test(url) && route.request().method() === 'POST') {
      lances.push(String((route.request().postDataJSON() as { workflowId?: string } | null)?.workflowId));
      if (refus) return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: refus }) });
      return json({ ok: true });
    }
    if (url.split('?')[0]!.endsWith('/conversations')) return json({ conversations: CONVERSATIONS });
    if (url.includes('/messages')) {
      return json({
        waId: '33600000001', windowOpen, lastInboundAt: '2026-08-15T11:00:00Z',
        controlOwner: 'app_human',
        messages: [{ id: 'm1', direction: 'in', type: 'text', body: 'coucou', buttonPayload: null, createdAt: '2026-08-15T11:00:00Z' }],
      });
    }
    if (url.endsWith('/workflows')) return json({ workflows: [WF_TEMPLATE, WF_SESSION] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

/** Ouvre la conversation puis le panneau de lancement de scénario. */
async function ouvrirPanneau(page: import('@playwright/test').Page) {
  await page.goto('/inbox');
  // Le clic sur le NOM ouvre la fiche du contact : pour ouvrir la conversation, on clique la vignette.
  await page.getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).first().click();
  // Deux fragilités traitées ensemble, toutes deux dues au fil qui se recharge tout seul (minuteur de 4 s) :
  // un clic tombé pile pendant le re-rendu de la barre d'actions vise un noeud détaché et se perd sans rien
  // signaler, et le panneau fraîchement monté affiche d'abord « aucun scénario » (liste vide) avant que sa
  // requête ne réponde. On réessaie donc le clic jusqu'à voir le SÉLECTEUR, seule preuve que le panneau est
  // ouvert ET chargé : tous les cas de ce fichier ont au moins un scénario proposable.
  await expect(async () => {
    await page.getByTestId('inbox-open-scenario').click();
    await expect(page.getByTestId('scenario-select')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

test.describe('Inbox : lancer un scénario', () => {
  test('fenêtre OUVERTE -> tous les scénarios sont proposés', async ({ page }) => {
    await mock(page, true, []);
    await ouvrirPanneau(page);
    const select = page.getByTestId('scenario-select');
    await expect(select.locator('option', { hasText: 'Relance promo' })).toHaveCount(1);
    await expect(select.locator('option', { hasText: 'Questionnaire à chaud' })).toHaveCount(1);
  });

  test('fenêtre FERMÉE -> seuls ceux qui ouvrent par un template', async ({ page }) => {
    await mock(page, false, []);
    await ouvrirPanneau(page);
    const select = page.getByTestId('scenario-select');
    // Le scénario à template reste, MÊME avec un tag devant lui : c'est ce qui OUVRE qui compte.
    await expect(select.locator('option', { hasText: 'Relance promo' })).toHaveCount(1);
    await expect(select.locator('option', { hasText: 'Questionnaire à chaud' })).toHaveCount(0);
  });

  test('lancer envoie bien l’identifiant du scénario choisi', async ({ page }) => {
    const lances: string[] = [];
    await mock(page, true, lances);
    await ouvrirPanneau(page);
    await page.getByTestId('scenario-select').selectOption('wf-qm');
    await page.getByTestId('scenario-send').click();
    await expect.poll(() => lances).toEqual(['wf-qm']);
  });

  test('🔴 la sélection survit à l’arrivée d’un message pendant que le panneau est ouvert', async ({ page }) => {
    // Le panneau était déclaré DANS le corps de Thread : le fil qui se rafraîchit (poll de 4 s) re-rendait
    // Thread, React voyait une fonction-composant d'identité différente, démontait la modale et la remontait
    // VIDE. Le scénario choisi disparaissait sous les doigts de l'utilisateur.
    //
    // Il faut un VRAI changement du fil : `load` garde la référence précédente quand rien n'a bougé (garde
    // anti-saut de scroll), donc un mock qui répète le même fil ne re-rend pas Thread et ne prouverait rien.
    let appels = 0;
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/conversations/unread-count')) return json({ count: 0 });
      if (url.split('?')[0]!.endsWith('/conversations')) return json({ conversations: CONVERSATIONS });
      if (url.includes('/messages')) {
        appels += 1;
        // Un message de plus à chaque tick : le contact continue d'écrire pendant qu'on choisit un scénario.
        const messages = Array.from({ length: appels }, (_, i) => ({
          id: `m${i + 1}`, direction: 'in', type: 'text', body: `message ${i + 1}`, buttonPayload: null, createdAt: '2026-08-15T11:00:00Z',
        }));
        return json({ waId: '33600000001', windowOpen: true, lastInboundAt: '2026-08-15T11:00:00Z', controlOwner: 'app_human', messages });
      }
      if (url.endsWith('/workflows')) return json({ workflows: [WF_TEMPLATE, WF_SESSION] });
      if (url.includes('/templates')) return json({ templates: [] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await ouvrirPanneau(page);
    await page.getByTestId('scenario-select').selectOption('wf-qm');
    const avant = appels;
    // Le rechargement est déclenché à la demande : le fil écoute `visibilitychange` en plus de son minuteur
    // de 4 s, et les deux passent par le même `load()`. Attendre le minuteur réel immobiliserait un worker
    // cinq secondes et faisait expirer les tests voisins.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => appels).toBeGreaterThan(avant); // le fil a bien rechargé
    await expect(page.getByTestId('scenario-select')).toHaveValue('wf-qm');
  });

  test('un refus du serveur s’affiche avec sa raison, pas un succès muet', async ({ page }) => {
    const lances: string[] = [];
    await mock(page, false, lances, 'le scénario ouvre par un message rapide ou un formulaire, impossible hors de la fenêtre de 24 h');
    await ouvrirPanneau(page);
    await page.getByTestId('scenario-select').selectOption('wf-tpl');
    await page.getByTestId('scenario-send').click();
    await expect(page.getByTestId('scenario-error')).toContainText('fenêtre de 24 h');
  });
});
