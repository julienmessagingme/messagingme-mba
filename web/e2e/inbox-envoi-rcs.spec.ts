import { test, expect } from '@playwright/test';

/**
 * E2E : envoyer un message RCS depuis l'Inbox.
 *
 * 🔴 Ce qu'on protège avant tout : le bouton doit être là QUAND LA FENÊTRE WHATSAPP EST FERMÉE. Cette fenêtre
 * de 24 h est une règle de WhatsApp, pas une règle du monde ; le RCS n'en a pas, et c'est précisément là qu'il
 * devient le moyen de reprendre contact sans template à faire approuver. Backend intercepté, comme les autres.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONVERSATIONS = [
  { id: 'c1', waId: '33600000001', profileName: 'Alice', lastPreview: 'coucou', lastMessageAt: '2026-08-15T11:00:00Z', controlOwner: 'app_human', unread: false },
];

const MESSAGES_RCS = [
  {
    id: 'lib-1',
    name: 'Offre du jour',
    content: {
      kind: 'card',
      card: { description: 'Bonjour {{prenom}}, notre offre', mediaUrl: 'https://exemple.test/v.png', mediaHeight: 'TALL', suggestions: [{ kind: 'reply', text: 'Je veux voir', postbackData: 'btn_1' }] },
    },
    createdAt: '', updatedAt: '',
  },
  // Un CARROUSEL : la bibliothèque sait en composer depuis le 2026-09-21, et ce panneau doit le dessiner.
  {
    id: 'lib-2',
    name: 'Sélection rentrée',
    content: {
      kind: 'carousel',
      cards: [
        { title: 'Séjour à Nice', mediaUrl: 'https://exemple.test/a.png', mediaHeight: 'TALL' },
        { title: 'Séjour à Lyon', mediaUrl: 'https://exemple.test/b.png', mediaHeight: 'TALL' },
      ],
    },
    createdAt: '', updatedAt: '',
  },
  // Un contenu que le schéma courant ne relit plus (`content: null`) : le serveur REFUSE de l'envoyer.
  { id: 'lib-3', name: 'Ancien format', content: null, createdAt: '', updatedAt: '' },
];

async function mock(
  page: import('@playwright/test').Page,
  opts: { windowOpen: boolean; rcsEnabled?: boolean; envois: string[]; corps?: Array<Record<string, unknown>>; refus?: string },
) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/conversations/unread-count')) return json({ count: 0 });
    if (/\/conversations\/[^/]+\/send-rcs$/.test(url) && route.request().method() === 'POST') {
      const corps = (route.request().postDataJSON() ?? {}) as { rcsMessageId?: string };
      opts.corps?.push(corps);
      opts.envois.push(String(corps.rcsMessageId));
      if (opts.refus) {
        return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: opts.refus }) });
      }
      return json({ messageId: 'rcs-1' });
    }
    if (url.split('?')[0]!.endsWith('/conversations')) return json({ conversations: CONVERSATIONS });
    if (url.includes('/messages') && !url.includes('/rcs-messages')) {
      return json({
        waId: '33600000001', windowOpen: opts.windowOpen, lastInboundAt: '2026-08-15T11:00:00Z',
        controlOwner: 'app_human',
        messages: [{ id: 'm1', direction: 'in', type: 'text', body: 'coucou', buttonPayload: null, createdAt: '2026-08-15T11:00:00Z' }],
      });
    }
    if (url.includes('/rcs-messages')) return json({ messages: MESSAGES_RCS });
    if (url.includes('/settings')) return json({ rcsEnabled: opts.rcsEnabled !== false, mbaEnabled: false });
    if (url.endsWith('/workflows')) return json({ workflows: [] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

/** Ouvre la conversation, puis le panneau RCS. Réessai identique aux autres specs d'inbox : le fil se
 *  recharge tout seul toutes les 4 s, un clic tombé pendant le re-rendu vise un nœud détaché. */
async function ouvrirPanneau(page: import('@playwright/test').Page) {
  await page.goto('/inbox');
  await page.getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).first().click();
  await expect(async () => {
    await page.getByTestId('inbox-open-rcs').click();
    await expect(page.getByTestId('inbox-rcs-select')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

test.describe('Inbox : envoyer un RCS', () => {
  test('fenêtre FERMÉE : le RCS est proposé, et il part', async ({ page }) => {
    const envois: string[] = [];
    await mock(page, { windowOpen: false, envois });
    await ouvrirPanneau(page);

    await page.getByTestId('inbox-rcs-select').selectOption('lib-1');
    // L'aperçu montre le message tel que le contact le verra, boutons EN LISTE puisqu'il y a un visuel.
    await expect(page.getByTestId('rcs-preview-card-buttons')).toContainText('Je veux voir');

    await page.getByTestId('inbox-rcs-send').click();
    await expect.poll(() => envois.length, { timeout: 10_000 }).toBe(1);
    expect(envois[0]).toBe('lib-1');
  });

  test('🔴 réponse LIBRE : l opérateur écrit une phrase et elle part en RCS', async ({ page }) => {
    // Un contact joignable seulement en RCS n'était atteignable qu'à travers la bibliothèque : pour répondre
    // une phrase, il fallait créer une entrée de bibliothèque ou faire approuver un template WhatsApp.
    const envois: string[] = [];
    const corps: Array<Record<string, unknown>> = [];
    await mock(page, { windowOpen: false, envois, corps });
    await ouvrirPanneau(page);

    await page.getByTestId('inbox-rcs-mode-libre').click();
    // Le sélecteur de bibliothèque cède la place : deux champs ouverts en même temps rendraient l'envoi ambigu.
    await expect(page.getByTestId('inbox-rcs-select')).toHaveCount(0);

    await page.getByTestId('inbox-rcs-texte').fill('Je regarde et je reviens vers vous.');
    await page.getByTestId('inbox-rcs-send').click();

    await expect.poll(() => corps.length, { timeout: 10_000 }).toBe(1);
    expect(corps[0]).toEqual({ text: 'Je regarde et je reviens vers vous.' });
  });

  test('réponse libre vide : le bouton d envoi reste inerte', async ({ page }) => {
    const envois: string[] = [];
    await mock(page, { windowOpen: false, envois });
    await ouvrirPanneau(page);
    await page.getByTestId('inbox-rcs-mode-libre').click();
    await expect(page.getByTestId('inbox-rcs-send')).toBeDisabled();
  });

  test('fenêtre OUVERTE : le RCS reste proposé à côté de la réponse texte', async ({ page }) => {
    const envois: string[] = [];
    await mock(page, { windowOpen: true, envois });
    await ouvrirPanneau(page);
    await page.getByTestId('inbox-rcs-select').selectOption('lib-1');
    await page.getByTestId('inbox-rcs-send').click();
    await expect.poll(() => envois.length, { timeout: 10_000 }).toBe(1);
  });

  // Le refus du serveur NOMME sa cause (canal éteint, contact désabonné) : l'aplatir en « envoi impossible »
  // laisserait l'opérateur sans le geste à faire.
  test('un refus du serveur s’affiche avec sa raison', async ({ page }) => {
    const envois: string[] = [];
    await mock(page, { windowOpen: false, envois, refus: 'Ce contact s’est désabonné du RCS (il a répondu STOP).' });
    await ouvrirPanneau(page);
    await page.getByTestId('inbox-rcs-select').selectOption('lib-1');
    await page.getByTestId('inbox-rcs-send').click();
    await expect(page.getByTestId('inbox-rcs-error')).toContainText('désabonné');
  });

  // Le panneau annonçait « format que l'aperçu ne sait pas dessiner (carrousel) ». Il le dessine désormais.
  test('un carrousel de la bibliotheque se DESSINE avant de partir', async ({ page }) => {
    const envois: string[] = [];
    await mock(page, { windowOpen: false, envois });
    await ouvrirPanneau(page);
    await page.getByTestId('inbox-rcs-select').selectOption('lib-2');
    await expect(page.getByTestId('rcs-carrousel-apercu-carte-1')).toContainText('Séjour à Lyon');
    await page.getByTestId('inbox-rcs-send').click();
    await expect.poll(() => envois.length, { timeout: 10_000 }).toBe(1);
    expect(envois[0]).toBe('lib-2');
  });

  // 🔴 Le panneau promettait « il partira tel qu'il a été enregistré » à un message que le serveur refuse.
  test('un message illisible est dit illisible, pas promis au depart', async ({ page }) => {
    const envois: string[] = [];
    await mock(page, { windowOpen: false, envois });
    await ouvrirPanneau(page);
    await page.getByTestId('inbox-rcs-select').selectOption('lib-3');
    await expect(page.getByTestId('inbox-rcs-illisible')).toContainText('ne peut pas partir');
  });

  // Canal éteint : aucun bouton. Proposer un envoi qui finira en 422 n'aide personne.
  test('sans canal RCS activé, le bouton n’existe pas', async ({ page }) => {
    const envois: string[] = [];
    await mock(page, { windowOpen: false, rcsEnabled: false, envois });
    await page.goto('/inbox');
    await page.getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).first().click();
    await expect(page.getByTestId('inbox-open-scenario')).toBeVisible();
    await expect(page.getByTestId('inbox-open-rcs')).toHaveCount(0);
  });
});
