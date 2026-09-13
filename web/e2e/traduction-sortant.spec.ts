import { test, expect, type Page } from '@playwright/test';
import { TREIZE_POUCES, pasDeDebordement, pasDeChevauchement } from './aide/largeur';

/**
 * E2E : TRADUIRE AVANT D'ENVOYER, et ne surtout pas envoyer.
 *
 * 🔴 CE QUE SEUL UN TEST DE BOUT EN BOUT PEUT VOIR ICI. La route est tenue côté serveur ; ce qui se
 * décide À L'ÉCRAN, c'est que le clic REMPLACE le brouillon au lieu d'envoyer, et que le bouton NOMME
 * sa cible. Un composant qui enchaînerait traduction puis envoi passerait tous les tests de route,
 * afficherait exactement la même chose, et enverrait chez un client un texte que personne n'a relu.
 * Aucun message WhatsApp livré ne se rappelle.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONV = {
  id: 'c1', waId: '33600000001', profileName: 'Alice', lastPreview: 'Hola',
  lastMessageAt: '2026-09-12T10:00:00Z', controlOwner: 'app_human', unread: false, signaleeMain: false,
};

const MESSAGES = [
  { id: 'm1', direction: 'in', type: 'text', body: 'Hola, tengo un problema', buttonPayload: null, createdAt: '2026-09-12T10:00:00Z', channel: 'whatsapp' },
];

interface Options {
  /** La langue APPRISE du contact. `null` = on ne sait rien, le bouton nomme alors la langue par défaut. */
  langueContact?: string | null;
  /** Fenêtre de 24 h fermée : le composeur passe en mode TEMPLATE, qui ne se traduit pas. */
  fenetreFermee?: boolean;
}

async function monter(page: Page, opts: Options = {}) {
  const appels: string[] = [];
  const envois: unknown[] = [];
  const traductions: unknown[] = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    appels.push(`${req.method()} ${url.split('?')[0]}`);
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/conversations\/c1\/traduire$/.test(url)) {
      traductions.push(req.postDataJSON());
      return json({ texte: 'Hello, I am looking into it.', langueSource: 'fr', cible: 'en' });
    }
    if (/\/conversations\/c1\/reply$/.test(url)) {
      envois.push(req.postDataJSON());
      return json({ messageId: 'wamid.OUT' });
    }
    if (/\/conversations\/counts/.test(url)) return json({ tout: 1, aTraiter: 1, signalees: 0, archivees: 0, nonAffectees: 1, parMembre: [] });
    if (/\/c1\/messages$/.test(url.split('?')[0]!)) {
      return json({
        waId: CONV.waId,
        windowOpen: opts.fenetreFermee !== true,
        lastInboundAt: '2026-09-12T10:00:00Z',
        controlOwner: 'app_human',
        langueContact: opts.langueContact ?? null,
        messages: MESSAGES,
      });
    }
    if (/\/conversations(\?|$)/.test(url)) return json({ conversations: [CONV] });
    if (url.includes('/users')) return json({ users: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: SESSION.email, name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/inbox');
  await page.getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).first().click();
  await expect(page.getByTestId('fil-messages')).toBeVisible();
  return { appels, envois, traductions };
}

test.describe('Inbox : traduire un sortant avant de l’envoyer', () => {
  test('🔴 le bouton NOMME sa cible', async ({ page }) => {
    // « Traduire » tout court ne dit pas où part la phrase. La langue apprise du contact peut être
    // fausse une fois (un « ok », un emoji) : la nommer est la seule protection qui reste.
    await monter(page, { langueContact: 'es' });
    await expect(page.getByRole('button', { name: 'Traduire en espagnol' })).toBeVisible();
  });

  test('sans langue connue, il nomme la langue par défaut et ne ment pas', async ({ page }) => {
    // `null` n'est pas « français » : on n'a rien appris, donc on propose l'autre langue de la console
    // (ici l'anglais, la console étant en français), et on le DIT.
    await monter(page, { langueContact: null });
    await expect(page.getByRole('button', { name: 'Traduire en anglais' })).toBeVisible();
  });

  test('🔴 traduire REMPLACE le texte dans la zone de saisie, il n’envoie pas', async ({ page }) => {
    // LE CAS QUI PROTÈGE LE CLIENT. Rien ne part sans que l'opérateur ait vu le texte traduit.
    const { envois, traductions } = await monter(page, { langueContact: 'en' });
    await page.getByTestId('zone-saisie').fill('Bonjour, je regarde ça.');
    await page.getByRole('button', { name: /Traduire en/ }).click();
    await expect(page.getByTestId('zone-saisie')).toHaveValue(/Hello/);
    expect(envois).toHaveLength(0);
    // Et ce qui part au serveur est bien le texte de l'opérateur, avec la cible apprise du contact.
    expect(traductions).toEqual([{ texte: 'Bonjour, je regarde ça.', cible: 'en' }]);
  });

  test('🔴 l’envoi porte les DEUX textes : ce qui part, et ce qui avait été écrit', async ({ page }) => {
    // `body` gardera ce qui est PARTI (le client l'a reçu, notre trace doit y correspondre le jour d'un
    // litige) et `redaction_origine` ce que l'opérateur a écrit, sans quoi il ne peut plus se relire.
    const { envois } = await monter(page, { langueContact: 'en' });
    await page.getByTestId('zone-saisie').fill('Bonjour, je regarde ça.');
    await page.getByRole('button', { name: /Traduire en/ }).click();
    await expect(page.getByTestId('zone-saisie')).toHaveValue(/Hello/);
    await page.getByTestId('bouton-envoyer').click();
    await expect.poll(() => envois.length).toBe(1);
    expect(envois[0]).toEqual({
      text: 'Hello, I am looking into it.',
      redactionOrigine: 'Bonjour, je regarde ça.',
    });
  });

  test('🔴 un texte RETOUCHÉ après traduction perd sa rédaction d’origine', async ({ page }) => {
    // Sans cette remise à zéro, on mentirait dans la trace : l'opérateur retouche l'anglais à la main
    // et `redaction_origine` porterait encore un français qui n'a plus rien à voir avec ce qui part.
    // Une trace fausse est pire que pas de trace.
    const { envois } = await monter(page, { langueContact: 'en' });
    await page.getByTestId('zone-saisie').fill('Bonjour, je regarde ça.');
    await page.getByRole('button', { name: /Traduire en/ }).click();
    await expect(page.getByTestId('zone-saisie')).toHaveValue(/Hello/);
    await page.getByTestId('zone-saisie').fill('Hello, I am checking right now.');
    await page.getByTestId('bouton-envoyer').click();
    await expect.poll(() => envois.length).toBe(1);
    expect(envois[0]).toEqual({ text: 'Hello, I am checking right now.' });
  });

  test('🔴 le bouton est absent sur un envoi de template', async ({ page }) => {
    // UN TEMPLATE NE SE TRADUIT PAS : son texte est approuvé par Meta dans une langue donnée, et le
    // texte approuvé EST le texte. Hors fenêtre de 24 h, le composeur libre n'existe pas.
    await monter(page, { fenetreFermee: true });
    await expect(page.getByRole('button', { name: /Traduire/ })).toBeHidden();
    await expect(page.getByTestId('bouton-traduire')).toHaveCount(0);
  });

  test('rien ne déborde en 13 pouces', async ({ page }) => {
    await page.setViewportSize(TREIZE_POUCES);
    await monter(page, { langueContact: 'es' });
    await pasDeDebordement(page);
    await pasDeChevauchement(page, ['zone-saisie', 'bouton-traduire', 'bouton-envoyer']);
  });
});
