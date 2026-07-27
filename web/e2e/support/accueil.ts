import type { Page } from '@playwright/test';

/**
 * Prépare la page Accueil pour un test E2E : pose une session admin en localStorage AVANT tout script (sinon
 * AppShell redirige vers /login), puis intercepte tous les appels `/api/backend/*` avec des réponses fixtures.
 * Aucun backend ni base n'est requis : le vrai chemin front (rendu, toggles, panneau) est exercé en isolation.
 */

const TENANT = 't-e2e';
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: TENANT };

export type AccountFixture = Record<string, unknown>;

/** Compte par défaut : numéro connecté, qualité verte, MM Lite ONBOARDED, portail HubSpot non connecté. */
export const defaultAccount: AccountFixture = {
  hasNumber: true,
  phoneNumberId: 'PN1',
  number: '+33 5 25 68 02 50',
  tier: 'TIER_1K',
  quality: 'GREEN',
  numberStatus: 'CONNECTED',
  nameStatus: 'APPROVED',
  codeVerificationStatus: 'VERIFIED',
  throughputLevel: 'STANDARD',
  verifiedName: 'Messaging Me',
  wabaHealthStatus: 'AVAILABLE',
  accountReviewStatus: 'APPROVED',
  businessVerificationStatus: 'verified',
  marketingMessagesLiteApiStatus: 'ONBOARDED',
  ownerBusinessName: 'Messaging Me',
  hubspotConnected: false,
  hubspotPausedAt: null,
  hubspotPortal: { connected: false },
  status: { dot: 'green', label: 'Compte opérationnel', reason: 'Numéro connecté, qualité verte.' },
};

const defaultSettings = { controlHandbackSeconds: null, mbaEnabled: false, hubspotListsEnabled: false };

export async function mockAccueil(
  page: Page,
  over: { account?: AccountFixture; settings?: typeof defaultSettings; catchupTriggered?: boolean; numbersCount?: number } = {},
): Promise<void> {
  await page.addInitScript((s) => {
    window.localStorage.setItem('mba.session', JSON.stringify(s));
  }, SESSION);

  const account = { ...defaultAccount, ...over.account };
  const settings = over.settings ?? defaultSettings;
  // Liste des numéros (pour l'avertissement multi-numéros du dialogue de déconnexion). Défaut : 1 numéro.
  const phoneNumbers = Array.from({ length: over.numbersCount ?? 1 }, (_v, i) => ({ id: `PN${i + 1}`, displayPhoneNumber: '+33 5 25 68 02 50' }));

  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown): Promise<void> =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    // Toggle synchro par numéro (PATCH .../phone-numbers/:id/hubspot). action:'disconnect' -> réponse de déconnexion ;
    // sinon écho de `connected` + catchupTriggered mocké (pause/reprise).
    if (route.request().method() === 'PATCH' && url.endsWith('/hubspot')) {
      const b = (route.request().postDataJSON() ?? {}) as { connected?: boolean; action?: string };
      if (b.action === 'disconnect') return json({ phoneNumberId: 'PN1', hubspotConnected: false, disconnected: true });
      return json({ phoneNumberId: 'PN1', hubspotConnected: b.connected === true, catchupTriggered: over.catchupTriggered ?? false });
    }
    // Liste des numéros du tenant (GET .../phone-numbers, sans suffixe /hubspot).
    if (route.request().method() === 'GET' && url.endsWith('/phone-numbers')) return json({ phoneNumbers });
    if (url.includes('/account-status')) return json(account);
    if (url.includes('/settings')) return json(settings); // GET + PUT + PATCH control-handback : même forme
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.includes('/stats/templates')) return json({ breakdown: [], pricing: null });
    if (url.includes('/stats/cost')) return json({ marketing: [], utility: [], total: 0, hasRates: false });
    if (url.includes('/stats')) return json({ contacts: [], templates: { utility: [], marketing: [] }, exchanged: [] });
    return json({});
  });

  await page.goto('/accueil');
}
