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
  // Aucune photo par DÉFAUT : c'est l'état réel des numéros du parc, et un faux qui en poserait une ferait
  // passer le cas ordinaire (pas de pastille) pour l'exception.
  photoProfilUrl: null,
  hubspotConnected: false,
  hubspotPausedAt: null,
  hubspotPortal: { connected: false },
  status: { dot: 'green', label: 'Compte opérationnel', reason: 'Numéro connecté, qualité verte.' },
};

const defaultSettings = { controlHandbackSeconds: null, mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false };

export async function mockAccueil(
  page: Page,
  over: {
    // `& Record<string, unknown>` : un réglage plus récent que ce support (`hubspotActif`, migration 0179) se
    // passe sans le recopier ici. Absent, il reste absent : c'est le cas « API plus ancienne ».
    account?: AccountFixture; settings?: typeof defaultSettings & Record<string, unknown>; catchupTriggered?: boolean;
    numbersCount?: number; mbaStatus?: unknown;
    /** Fait échouer `PUT /mba-activation` en 409 avec ce message : le cas « on n'a pas pu lire chez Meta ». */
    activationRefusee?: string;
    /** Fait échouer `POST /numero/code` en 422 avec ce message (refus de Meta, quota, numéro déjà vérifié). */
    codeNumeroRefus?: string;
    /** Fait échouer `POST /numero/activer` en 422 avec ce message (code faux, register refusé). */
    activerNumeroRefus?: string;
    /**
     * Le bloc « Canaux et services » (2026-09-25). Chaque service garde un ÉTAT que ses gestes changent : délier
     * pose `delieLe` sur le statut du compte relu ensuite, couper le RCS le rend inactif, etc. Absent, chaque
     * lecture retombe sur `{}`, c'est-à-dire le comportement de ce support avant le bloc.
     */
    canaux?: {
      rcs?: { active: boolean; channel?: Record<string, unknown> };
      /** Réponse de `GET /channels-me/connection`. */
      chaine?: Record<string, unknown>;
      posts?: unknown[];
      /** Réponse de `GET /pubs/connexion`, ou `'absent'` : la route rend le 404 du routeur. */
      pubs?: Record<string, unknown> | 'absent';
      /** Les routes NEUVES (délier, relier, débrancher la chaîne) rendent le 404 du routeur : l'API plus ancienne. */
      routesAbsentes?: boolean;
      /** Rempli par le mock : « VERBE chemin » de chaque geste reçu. */
      gestes?: string[];
    };
  } = {},
): Promise<void> {
  await page.addInitScript((s) => {
    window.localStorage.setItem('mba.session', JSON.stringify(s));
  }, SESSION);

  const account = { ...defaultAccount, ...over.account };
  const settings = over.settings ?? defaultSettings;
  // Liste des numéros (pour l'avertissement multi-numéros du dialogue de déconnexion). Défaut : 1 numéro.
  const phoneNumbers = Array.from({ length: over.numbersCount ?? 1 }, (_v, i) => ({ id: `PN${i + 1}`, displayPhoneNumber: '+33 5 25 68 02 50' }));
  // L'état VIVANT des services du bloc « Canaux et services », que leurs gestes font changer.
  const canaux = over.canaux;
  const vivant = { rcs: canaux?.rcs, chaine: canaux?.chaine, pubs: canaux?.pubs };

  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown): Promise<void> =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (canaux) {
      const methode = route.request().method();
      const chemin = new URL(url).pathname.replace('/api/backend', '');
      const routeur404 = (): Promise<void> => route.fulfill({
        status: 404, contentType: 'application/json',
        body: JSON.stringify({ message: `Route ${methode}:${chemin} not found`, error: 'Not Found', statusCode: 404 }),
      });
      const geste = (): void => { canaux.gestes?.push(`${methode} ${chemin}`); };
      if (methode === 'POST' && chemin.endsWith('/numero/delier')) {
        geste();
        if (canaux.routesAbsentes) return routeur404();
        account.delieLe = '2026-09-25T10:00:00.000Z';
        return json({ delie: true, delieLe: account.delieLe, campagnesEnPause: 2 });
      }
      if (methode === 'POST' && chemin.endsWith('/numero/relier')) {
        geste();
        if (canaux.routesAbsentes) return routeur404();
        account.delieLe = null;
        return json({ relie: true, campagnesReprises: 1, campagnesReprogrammees: 1 });
      }
      if (chemin.endsWith('/rcs/channel')) {
        if (methode === 'DELETE') { geste(); vivant.rcs = { active: false }; return json({ active: false }); }
        if (methode === 'GET' && vivant.rcs) return json(vivant.rcs);
      }
      if (chemin.endsWith('/channels-me/connection')) {
        if (methode === 'DELETE') {
          geste();
          if (canaux.routesAbsentes) return routeur404();
          vivant.chaine = { ...vivant.chaine, connection: null };
          return json({ ok: true, supprimee: true });
        }
        if (methode === 'GET' && vivant.chaine) return json(vivant.chaine);
      }
      if (methode === 'GET' && chemin.endsWith('/channels-me/posts') && canaux.posts) return json({ posts: canaux.posts, distant: 'ok' });
      if (chemin.endsWith('/pubs/connexion')) {
        if (methode === 'DELETE') {
          geste();
          if (vivant.pubs && vivant.pubs !== 'absent') vivant.pubs = { ...vivant.pubs, connexion: null };
          return json({ ok: true, revoqueChezMeta: true });
        }
        if (methode === 'GET' && vivant.pubs === 'absent') return routeur404();
        if (methode === 'GET' && vivant.pubs) return json(vivant.pubs);
      }
      if (methode === 'PATCH' && chemin.endsWith('/settings/hubspot-actif')) {
        geste();
        const b = (route.request().postDataJSON() ?? {}) as { actif?: boolean };
        return json({ hubspotActif: b.actif === true });
      }
    }
    // Toggle synchro par numéro (PATCH .../phone-numbers/:id/hubspot). action:'disconnect' -> réponse de déconnexion ;
    // sinon écho de `connected` + catchupTriggered mocké (pause/reprise).
    if (route.request().method() === 'PATCH' && url.endsWith('/hubspot')) {
      const b = (route.request().postDataJSON() ?? {}) as { connected?: boolean; action?: string };
      if (b.action === 'disconnect') return json({ phoneNumberId: 'PN1', hubspotConnected: false, disconnected: true });
      return json({ phoneNumberId: 'PN1', hubspotConnected: b.connected === true, catchupTriggered: over.catchupTriggered ?? false });
    }
    // Déconnexion complète d'un espace SANS numéro (POST .../hubspot/deconnexion, migration 0179).
    if (route.request().method() === 'POST' && url.endsWith('/hubspot/deconnexion')) return json({ hubspotConnected: false, disconnected: true });
    // Liste des numéros du tenant (GET .../phone-numbers, sans suffixe /hubspot).
    if (route.request().method() === 'GET' && url.endsWith('/phone-numbers')) return json({ phoneNumbers });
    // 🔴 L'ETAT REEL DE L'AGENT CHEZ META, mockable par les specs. La carte d'accueil l'affiche depuis le
    // 2026-09-10 : avant, elle montrait notre drapeau local sous une phrase ecrite en dur annoncant qu'on
    // attendait l'ouverture de Meta. Les deux etaient faux le meme jour. Defaut : eligible et ETEINT, le
    // cas le plus courant d'un numero fraichement ouvert.
    if (url.includes('/mba/') && url.endsWith('/status')) return json(over.mbaStatus ?? { phoneNumberId: 'PN1', eligible: true, onboarded: true, agentId: 'ag1', settings: { rollout: { enabled: false }, ai_audience: 'EVERYONE' } });
    if (url.includes('/mba/') && url.endsWith('/rollout')) return json({ rollout: { enabled: true }, ai_audience: 'EVERYONE' });
    /**
     * 🔴 LA ROUTE UNIQUE D'ACTIVATION (2026-09-10). Elle a remplacé une orchestration côté navigateur qui a
     * cassé trois fois dans la même journée : le bouton n'échouait pas, il SAUTAIT l'appel à Meta et écrivait
     * notre drapeau quand même. Le serveur décide désormais tout et rend ce qu'il a RÉELLEMENT fait, ce que
     * ce mock reproduit : il fait l'écho de l'intention reçue, il ne la devine pas.
     */
    if (url.endsWith('/mba-activation')) {
      if (over.activationRefusee) {
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: over.activationRefusee }) });
      }
      const b = (route.request().postDataJSON() ?? {}) as { enabled?: boolean };
      return json({ enabled: b.enabled === true, chezMeta: 'applique', phoneNumberId: 'PN1' });
    }
    // « Activer le numéro » (2026-09-22). Le mock fait l'ÉCHO du canal reçu, il ne le devine pas : c'est ce
    // qui permet au test de vérifier que l'écran envoie bien VOICE par défaut.
    if (url.endsWith('/numero/code')) {
      if (over.codeNumeroRefus) return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: over.codeNumeroRefus }) });
      const b = (route.request().postDataJSON() ?? {}) as { methode?: string };
      return json({ envoye: true, methode: b.methode ?? 'VOICE' });
    }
    if (url.endsWith('/numero/activer')) {
      if (over.activerNumeroRefus) return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: over.activerNumeroRefus }) });
      return json({ actif: true });
    }
    if (url.includes('/account-status')) return json(account);
    if (url.includes('/settings')) return json(settings); // GET + PUT + PATCH control-handback : même forme
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.includes('/stats/templates')) return json({ breakdown: [], pricing: null });
    if (url.includes('/stats/cost')) return json({ marketing: [], utility: [], total: 0, hasRates: false, currency: null });
    if (url.includes('/stats')) return json({ contacts: [], templates: { utility: [], marketing: [] }, exchanged: [], service: [] });
    return json({});
  });

  await page.goto('/accueil');
}
