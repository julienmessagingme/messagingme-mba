import { test, expect } from '@playwright/test';

/**
 * E2E « Mes tableaux » : la mesure des CLICS SUR UN LIEN de template.
 *
 * Ce que ces tests tiennent ensemble, et qu'aucun test unitaire ne peut tenir seul : un bouton URL ne doit
 * PLUS proposer la case « a cliqué » de nature choix (Meta n'émet rien, elle restait à zéro pour toujours),
 * et il doit proposer la case de clic UNIQUEMENT si son lien est tracé.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

/** Un bloc template portant un bouton de choix PUIS un bouton URL : l'index Meta du lien est donc 1. */
const GRAPH = {
  nodes: [
    {
      id: 'n1',
      type: 'template',
      position: { x: 0, y: 0 },
      data: {
        templateName: 'promo',
        language: 'fr',
        templateButtons: [
          { type: 'QUICK_REPLY', text: 'Oui' },
          { type: 'URL', text: 'Voir le site', url: 'https://client.fr/promo' },
        ],
      },
    },
  ],
  edges: [],
};

/** `counts` avec ou sans la ligne de clic : c'est le SERVEUR qui dit si le lien est tracé. */
const AVEC_LIEN = [
  { nodeId: 'n1', kind: 'sent', handle: null, count: 40, contacts: 40 },
  { nodeId: 'n1', kind: 'url_click', handle: 'btn:1', count: 12, contacts: null },
];
const SANS_LIEN = [{ nodeId: 'n1', kind: 'sent', handle: null, count: 40, contacts: 40 }];

async function monter(page: import('@playwright/test').Page, counts: unknown[]) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/workflow-reports')) return json({ reports: [] });
    if (url.includes('/stats/workflow/')) return json({ counts });
    if (/\/workflows\/wf-1(\?|$)/.test(url)) return json({ workflow: { id: 'wf-1', name: 'Parcours promo', graph: GRAPH } });
    if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf-1', name: 'Parcours promo', graph: GRAPH }] });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/dashboard/tableaux');
  await page.getByTestId('tableaux-scenario').selectOption('wf-1');
  await page.getByTestId('bloc-mesurable').first().click();
  await expect(page.getByTestId('bloc-mesures')).toBeVisible({ timeout: 15_000 });
}

test.describe('Mes tableaux : clics sur un lien de template', () => {
  test('🔴 un bouton URL tracé propose « A cliqué sur le lien », et PAS de case de choix', async ({ page }) => {
    await monter(page, AVEC_LIEN);
    const panneau = page.getByTestId('bloc-mesures');
    await expect(panneau).toContainText('A cliqué sur le lien « Voir le site »');
    // Le bouton de CHOIX reste proposé, lui : Meta émet bien un événement quand on le clique.
    await expect(panneau).toContainText('A cliqué « Oui »');
    // Mais aucune case de choix ne porte le bouton URL : c'était la case qui mentait.
    await expect(panneau).not.toContainText('A cliqué « Voir le site »');
  });

  test('🔴 un bouton URL NON tracé ne propose AUCUNE case', async ({ page }) => {
    // Un template approuvé avant la mise en service porte l'adresse du client en dur : rien ne le mesurera,
    // et proposer la case reproduirait exactement le défaut qu'on vient de corriger.
    await monter(page, SANS_LIEN);
    const panneau = page.getByTestId('bloc-mesures');
    await expect(panneau).toContainText('A cliqué « Oui »');
    await expect(panneau).not.toContainText('Voir le site');
  });

  test('la barre de clics porte le compteur de la période', async ({ page }) => {
    await monter(page, AVEC_LIEN);
    await page.getByTestId('mesure-url_click').check();
    await expect(page.getByTestId('barre')).toHaveCount(1);
    await expect(page.getByTestId('tableaux-graphe')).toContainText('12');
    await expect(page.getByTestId('tableau-legende')).toContainText('A cliqué sur le lien « Voir le site »');
  });

  test('🔴 un clic de lien ne prend pas la couleur du bouton de choix voisin', async ({ page }) => {
    // Dans un même bloc, « a cliqué « Oui » » et « a cliqué sur le lien » sont deux gestes différents : les
    // peindre pareil les confondrait à l'oeil, et c'est justement le bloc où on veut les comparer.
    await monter(page, [...AVEC_LIEN, { nodeId: 'n1', kind: 'reply_button', handle: 'btn:0', count: 5, contacts: 5 }]);
    await page.getByTestId('mesure-reply_button').first().check();
    await page.getByTestId('mesure-url_click').check();
    const couleurs = await page.getByTestId('barre').locator('rect').evaluateAll((n) => n.map((r) => r.getAttribute('fill')));
    expect(couleurs).toHaveLength(2);
    expect(couleurs[0]).not.toBe(couleurs[1]);
  });
});
