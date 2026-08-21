import { test, expect } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * E2E : le contrôle du fil ne se règle plus conversation par conversation.
 *
 * Ce fichier REMPLACE le test de la surcharge de reprise par conversation (« À la reprise : défaut du compte /
 * repart au scénario / reste à traiter »), supprimée avec la migration 0059. Il n'est pas jeté mais retourné :
 * là où il vérifiait que le sélecteur écrivait le bon réglage, il vérifie maintenant qu'il n'existe PLUS, et
 * que le seul réglage restant, le délai, n'a qu'un unique endroit (MBA > Paramètres > Activation).
 *
 * Pourquoi c'est un test et pas une simple suppression : la simplification est la fonctionnalité. Si quelqu'un
 * réintroduit un choix par conversation, la règle « le délai décide seul » redevient fausse en silence.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const CONV = { id: 'c1', waId: '33600000001', profileName: 'Alice Retour', lastPreview: 'coucou', lastMessageAt: '2026-08-02T10:00:00Z', controlOwner: 'app_human' };
const THREAD = {
  waId: '33600000001', windowOpen: true, lastInboundAt: '2026-08-02T10:00:00Z', controlOwner: 'app_human',
  messages: [{ id: 'm1', direction: 'in', type: 'text', body: 'coucou', buttonPayload: null, createdAt: '2026-08-02T10:00:00Z' }],
};
const REGLAGES = { mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} };

test.describe('Contrôle du fil : un seul réglage, à un seul endroit', () => {
  test('🔴 l’Inbox n’offre PLUS de choix de reprise par conversation', async ({ page }) => {
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    const appels: string[] = [];
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      appels.push(`${route.request().method()} ${url}`);
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.endsWith('/c1/messages')) return json(THREAD);
      if (url.split('?')[0]!.endsWith('/conversations')) return json({ conversations: [CONV] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await page.goto('/inbox');
    // La vignette ouvre la conversation. Le clic sur le NOM ouvre desormais la fiche du contact : ce sont
    // deux gestes distincts depuis le lot du 2026-08-21.
    await page.getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).click();
    // Le fil s'ouvre bel et bien : sans cette assertion, un écran cassé passerait pour un écran sans sélecteur.
    await expect(page.getByText(/fenêtre 24 h ouverte|24h window open/)).toBeVisible();

    await expect(page.getByTestId('thread-return-select')).toHaveCount(0);
    expect(appels.filter((a) => a.includes('return-behavior'))).toEqual([]);
  });

  test('le délai de reprise n’a qu’UN seul endroit, et ce n’est ni l’inbox ni l’accueil', async ({ page }) => {
    // Le délai a rejoint MBA > Paramètres > Activation. Ce que ce test protège ici, c'est son UNICITÉ : deux
    // champs qui écrivent le même réglage à deux endroits, c'est la porte ouverte à deux valeurs affichées.
    // La saisie elle-même (minutes à l'écran, secondes sur le fil) est vérifiée par `mba-activation.spec.ts`.
    await mockAccueil(page);
    await expect(page.getByTestId('handback-input')).toHaveCount(0);
    await expect(page.getByTestId('return-behavior-select')).toHaveCount(0);
    await expect(page.getByTestId('lien-activation')).toBeVisible();
  });
});
