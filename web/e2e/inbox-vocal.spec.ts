import { test, expect } from '@playwright/test';

/**
 * UN VOCAL DANS LE FIL (2026-09-09, demande de Julien).
 *
 * 🔴 CE QUE SEUL UN TEST DE BOUT EN BOUT PEUT VOIR ICI. Les routes sont tenues côté serveur ; ce qui se
 * décide À L'ÉCRAN, c'est QUAND les octets partent. Un composant qui téléchargerait le vocal au rendu
 * passerait tous les tests de route, afficherait exactement la même chose, et tirerait vingt méga à
 * l'ouverture d'un fil de dix vocaux, pour des fichiers que personne n'écoutera.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONV = {
  id: 'c1', waId: '33600000001', profileName: 'Alice', lastPreview: '[audio]',
  lastMessageAt: '2026-09-09T10:00:00Z', controlOwner: 'app_human', unread: false,
  curseur: '2026-09-09T10:00:00Z', signaleeMain: false,
};

function messages(opts: { transcription?: string | null } = {}) {
  return [
    { id: 'm-texte', direction: 'in', type: 'text', body: 'bonjour', buttonPayload: null, createdAt: '2026-09-09T09:59:00Z', channel: 'whatsapp' },
    {
      id: 'm-vocal', direction: 'in', type: 'audio', body: '[audio]', buttonPayload: null,
      createdAt: '2026-09-09T10:00:00Z', channel: 'whatsapp', aMedia: true,
      transcription: opts.transcription ?? null,
    },
  ];
}

async function monter(page: import('@playwright/test').Page, opts: { transcription?: string | null; appels?: string[] } = {}) {
  const appels = opts.appels ?? [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    appels.push(`${req.method()} ${url}`);
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/messages\/m-vocal\/media$/.test(url)) {
      // Un ogg minuscule mais réel : le lecteur doit recevoir des octets, pas du JSON.
      return route.fulfill({ status: 200, contentType: 'audio/ogg', body: Buffer.from('OggS-faux-audio') });
    }
    if (/\/messages\/m-vocal\/transcrire$/.test(url)) return json({ texte: 'Bonjour, ma commande est-elle partie ?', deja: false });
    if (/\/conversations\/counts/.test(url)) return json({ tout: 1, aTraiter: 1, signalees: 0, archivees: 0, nonAffectees: 1, parMembre: [] });
    if (url.endsWith('/c1/messages')) return json({ messages: messages(opts), windowOpen: true, controlOwner: 'app_human' });
    if (/\/conversations\?|\/conversations$/.test(url)) return json({ conversations: [CONV] });
    if (url.includes('/users')) return json({ users: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: SESSION.email, name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/inbox');
  await page.getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).first().click();
  await page.getByTestId('vocal-m-vocal').waitFor();
  return appels;
}

test.describe('Inbox : un vocal s’écoute ou se transcrit', () => {
  test('🔴 RIEN n’est téléchargé au rendu : les octets ne partent qu’au clic', async ({ page }) => {
    // La garde qui porte tout l'intérêt du « à la demande ». Un composant qui chargerait à l'affichage
    // afficherait exactement la même chose et coûterait la bande passante de tous les vocaux du fil.
    const appels = await monter(page);
    expect(appels.filter((a) => /\/media$/.test(a))).toHaveLength(0);

    await page.getByTestId('vocal-ecouter-m-vocal').click();
    await expect.poll(() => appels.filter((a) => /GET .*\/messages\/m-vocal\/media$/.test(a)).length, { timeout: 10_000 }).toBe(1);
    await expect(page.getByTestId('vocal-lecteur-m-vocal')).toBeVisible();
  });

  test('🔴 transcrire n’est PAS automatique non plus', async ({ page }) => {
    // Julien : « il faut qu'il ait le choix ». Transcrire tout ferait payer un service que personne n'a
    // demandé, et ce test le fige : aucun appel avant le clic.
    const appels = await monter(page);
    expect(appels.filter((a) => /transcrire$/.test(a))).toHaveLength(0);

    await page.getByTestId('vocal-transcrire-m-vocal').click();
    await expect(page.getByTestId('vocal-texte-m-vocal')).toContainText('ma commande est-elle partie');
  });

  test('🔴 la transcription est MARQUÉE comme telle', async ({ page }) => {
    // C'est la lecture d'un modèle, pas ce que le client a écrit. La présenter comme une citation ferait
    // prendre une supposition pour un fait, et un opérateur qui reprend une conversation menée par l'IA
    // n'aurait aucun moyen de le savoir.
    await monter(page, { transcription: 'texte deja transcrit' });
    await expect(page.getByTestId('vocal-texte-m-vocal')).toContainText(/transcription|transcript/i);
  });

  test('🔴 un vocal DÉJÀ transcrit ne propose plus de le transcrire', async ({ page }) => {
    // Sinon on repaierait la même seconde d'audio, et la seconde transcription écraserait la première par
    // une variante différente, ce qui ferait douter de celle qu'on venait de lire.
    await monter(page, { transcription: 'texte deja transcrit' });
    await expect(page.getByTestId('vocal-transcrire-m-vocal')).toHaveCount(0);
    // ...mais il reste ÉCOUTABLE : le texte ne remplace pas le vocal, il s'y ajoute.
    await expect(page.getByTestId('vocal-ecouter-m-vocal')).toBeVisible();
  });

  test('🔴 la preuve inverse : un message TEXTE n’a ni lecteur ni bouton', async ({ page }) => {
    // Sans ce cas, un composant monté sur tous les messages passerait les quatre tests ci-dessus tout en
    // proposant d'écouter une phrase tapée au clavier.
    await monter(page);
    await expect(page.getByTestId('vocal-m-texte')).toHaveCount(0);
    await expect(page.getByTestId('vocal-ecouter-m-texte')).toHaveCount(0);
  });
});
