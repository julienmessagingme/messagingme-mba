import { test, expect } from '@playwright/test';

/**
 * LES PIÈCES JOINTES REÇUES DANS LE FIL (2026-09-19, demande de Julien : « dans les conversations on doit
 * pouvoir recevoir des photos... voire des fichiers »).
 *
 * 🔴 CE QUE SEUL UN TEST DE BOUT EN BOUT PEUT VOIR ICI : QUAND les octets partent (une photo au rendu, un
 * document au clic), SOUS QUEL NOM le fichier s'enregistre, et surtout qu'un fichier qui se DIT image mais
 * n'en est pas une ne soit jamais rendu dans la page. Les routes et la base sont tenues ailleurs.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONV = {
  id: 'c1', waId: '33600000001', profileName: 'Alice', lastPreview: '[document]',
  lastMessageAt: '2026-09-19T10:00:00Z', controlOwner: 'app_human', unread: false,
  curseur: '2026-09-19T10:00:00Z', signaleeMain: false,
};

/** Une vraie image PNG d'un pixel : la balise doit recevoir des octets d'image, pas du JSON. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const base = { direction: 'in', buttonPayload: null, channel: 'whatsapp', aMedia: true };
const MESSAGES = [
  { ...base, id: 'm-photo', type: 'image', body: 'Voici la casse', createdAt: '2026-09-19T09:00:00Z' },
  { ...base, id: 'm-doc', type: 'document', body: '[document]', createdAt: '2026-09-19T09:01:00Z', mediaNom: 'facture-mars.pdf' },
  { ...base, id: 'm-faux', type: 'image', body: '[image]', createdAt: '2026-09-19T09:02:00Z' },
  { ...base, id: 'm-vieille', type: 'image', body: '[image]', createdAt: '2026-09-01T09:00:00Z', mediaExpire: true },
  { ...base, id: 'm-vocal-vieux', type: 'audio', body: '[audio]', createdAt: '2026-09-01T09:01:00Z', mediaExpire: true, transcription: null },
  { ...base, id: 'm-doc-perdu', type: 'document', body: '[document]', createdAt: '2026-09-19T09:03:00Z', mediaNom: 'devis.pdf' },
];

async function monter(page: import('@playwright/test').Page, appels: string[] = []) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    appels.push(`${req.method()} ${url}`);
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/messages\/m-photo\/media$/.test(url)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    if (/\/messages\/m-doc\/media$/.test(url)) return route.fulfill({ status: 200, contentType: 'application/pdf', body: Buffer.from('%PDF-1.4 faux') });
    // Un fichier qui se dit « image » dans le fil mais que le serveur sert en HTML : il ne doit JAMAIS
    // être rendu dans la page.
    if (/\/messages\/m-faux\/media$/.test(url)) return route.fulfill({ status: 200, contentType: 'text/html', body: '<script>window.__pirate = 1</script>' });
    // WhatsApp l'a effacé plus tôt que prévu : le serveur le dit par un 410.
    if (/\/messages\/m-doc-perdu\/media$/.test(url)) return json({ error: 'expiré', code: 'media_expire' }, 410);
    if (/\/conversations\/counts/.test(url)) return json({ tout: 1, aTraiter: 1, signalees: 0, archivees: 0, traitees: 0, nonAffectees: 1, parMembre: [] });
    if (url.endsWith('/c1/messages')) return json({ messages: MESSAGES, windowOpen: true, controlOwner: 'app_human' });
    if (/\/conversations\?|\/conversations$/.test(url)) return json({ conversations: [CONV] });
    if (url.includes('/users')) return json({ users: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: SESSION.email, name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/inbox');
  await page.getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).first().click();
  await page.getByTestId('piece-jointe-m-doc').waitFor();
  return appels;
}

test.describe('Inbox : les pièces jointes reçues', () => {
  test('🔴 une photo s’AFFICHE dans la bulle, avec la légende de l’expéditeur', async ({ page }) => {
    await monter(page);
    const img = page.getByTestId('piece-jointe-image-m-photo');
    await expect(img).toBeVisible();
    expect(await img.getAttribute('src')).toMatch(/^blob:/);
    await expect(page.getByTestId('piece-jointe-m-photo')).toContainText('Voici la casse');
  });

  test('🔴 un document ne part qu’AU CLIC, et s’enregistre sous le nom annoncé par WhatsApp', async ({ page }) => {
    const appels = await monter(page);
    // La photo se charge au rendu, le document non : un PDF de dix méga ne doit partir que si on le demande.
    await expect.poll(() => appels.filter((a) => /\/m-photo\/media$/.test(a)).length, { timeout: 10_000 }).toBe(1);
    expect(appels.filter((a) => /\/m-doc\/media$/.test(a))).toHaveLength(0);

    const telechargement = page.waitForEvent('download');
    await page.getByTestId('piece-jointe-telecharger-m-doc').click();
    expect((await telechargement).suggestedFilename()).toBe('facture-mars.pdf');
  });

  test('🔴 un fichier qui se DIT image mais n’en est pas une n’est jamais rendu dans la page', async ({ page }) => {
    // La frontière de sécurité, à l'écran : un HTML rendu dans l'origine de la console lirait la session.
    await monter(page);
    await expect(page.getByTestId('piece-jointe-telecharger-m-faux')).toBeVisible();
    await expect(page.getByTestId('piece-jointe-image-m-faux')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pirate?: number }).__pirate)).toBeUndefined();
  });

  test('🔴 une photo EXPIRÉE le dit, et ne va rien chercher', async ({ page }) => {
    const appels = await monter(page);
    await expect(page.getByTestId('piece-jointe-expiree-m-vieille')).toContainText('7 jours');
    expect(appels.filter((a) => /\/m-vieille\/media$/.test(a))).toHaveLength(0);
  });

  test('🔴 un vocal EXPIRÉ n’offre plus ni « Écouter » ni « Transcrire »', async ({ page }) => {
    await monter(page);
    await expect(page.getByTestId('vocal-expire-m-vocal-vieux')).toContainText('7 jours');
    await expect(page.getByTestId('vocal-ecouter-m-vocal-vieux')).toHaveCount(0);
    await expect(page.getByTestId('vocal-transcrire-m-vocal-vieux')).toHaveCount(0);
  });

  test('un fichier effacé PLUS TÔT par WhatsApp (410) se dit expiré, pas « réessayez »', async ({ page }) => {
    await monter(page);
    await page.getByTestId('piece-jointe-telecharger-m-doc-perdu').click();
    await expect(page.getByTestId('piece-jointe-expiree-m-doc-perdu')).toContainText('devis.pdf');
    await expect(page.getByTestId('piece-jointe-erreur-m-doc-perdu')).toHaveCount(0);
  });
});
