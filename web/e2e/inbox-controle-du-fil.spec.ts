import { test, expect } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * E2E : le contrôle du fil ne se règle plus conversation par conversation.
 *
 * Ce fichier REMPLACE le test de la surcharge de reprise par conversation (« À la reprise : défaut du compte /
 * repart au scénario / reste à traiter »), supprimée avec la migration 0059. Il n'est pas jeté mais retourné :
 * là où il vérifiait que le sélecteur écrivait le bon réglage, il vérifie maintenant qu'il n'existe PLUS, et
 * que le seul réglage restant est le délai sur l'accueil.
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

test.describe('Contrôle du fil : un seul réglage, sur l’accueil', () => {
  test('🔴 l’Inbox n’offre PLUS de choix de reprise par conversation', async ({ page }) => {
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    const appels: string[] = [];
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      appels.push(`${route.request().method()} ${url}`);
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.endsWith('/c1/messages')) return json(THREAD);
      if (url.endsWith('/conversations')) return json({ conversations: [CONV] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await page.goto('/inbox');
    await page.getByText('Alice Retour').click();
    // Le fil s'ouvre bel et bien : sans cette assertion, un écran cassé passerait pour un écran sans sélecteur.
    await expect(page.getByText(/fenêtre 24 h ouverte|24h window open/)).toBeVisible();

    await expect(page.getByTestId('thread-return-select')).toHaveCount(0);
    expect(appels.filter((a) => a.includes('return-behavior'))).toEqual([]);
  });

  test('le délai de reprise se règle sur l’accueil, et il parle de la main de l’humain', async ({ page }) => {
    // Le harnais partagé de l'accueil pose le compte et les réglages ; on ajoute UNE route plus spécifique
    // après lui (Playwright donne la priorité à la dernière enregistrée) puis on recharge pour qu'elle serve.
    await mockAccueil(page);
    const patches: Array<Record<string, unknown>> = [];
    await page.route('**/api/backend/**/settings/control-handback', async (route) => {
      patches.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ controlHandbackSeconds: 600 }) });
    });
    await page.reload();

    const champ = page.getByTestId('handback-input');
    await expect(champ).toBeVisible();
    // Il n'y a plus de choix de destination à côté : le délai est le seul réglage du contrôle du fil.
    await expect(page.getByTestId('return-behavior-select')).toHaveCount(0);

    await champ.fill('10');
    await champ.blur();
    await expect.poll(() => patches.length).toBeGreaterThan(0);
    expect(patches[patches.length - 1]).toEqual({ seconds: 600 });
  });
});
