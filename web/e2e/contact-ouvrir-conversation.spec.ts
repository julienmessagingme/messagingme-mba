import { test, expect } from '@playwright/test';

/**
 * « OUVRIR LA CONVERSATION » DEPUIS LA FICHE D'UN CONTACT (demande de Julien du 2026-09-23).
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT, ET CE N'EST PAS LE BOUTON. Le chemin utile est celui du contact qui n'a
 * JAMAIS écrit : il n'a pas de fil, et c'est exactement quand on veut lui parler qu'on ouvre sa fiche. Le
 * bouton doit donc demander au serveur de créer le fil, PUIS emmener sur ce fil-là. Un bouton qui naviguerait
 * vers l'Inbox sans identifiant aurait l'air de marcher et ne montrerait rien.
 *
 * ⚠️ ET SON ÉCHEC SE DIT. Un contact sans identité joignable rend 404, une API pas encore déployée rend 503 :
 * dans les deux cas, un bouton qui ne fait rien en silence se lit comme une panne de l'écran.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const CONV = '11111111-1111-4111-8111-111111111111';

const CONTACT = {
  id: 'ct1', profileName: 'Anna Nouvelle', phoneE164: '+33600000001', bsuid: null,
  optInStatus: 'opted_in', tags: [], fields: {}, createdAt: '2026-01-01T00:00:00Z',
  whatsappJoignable: null, whatsappJoignableLe: null,
};

async function mock(page: import('@playwright/test').Page, ouverture: 'ok' | 404 | 503 = 'ok'): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const chemin = url.split('?')[0]!;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/contacts/ct1/conversation')) {
      if (ouverture === 404) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"contact introuvable ou sans numero"}' });
      if (ouverture === 503) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"ouverture de conversation non configuree"}' });
      return json({ conversationId: CONV });
    }
    if (chemin.endsWith('/conversations/todo-count')) return json({ count: 0 });
    if (chemin.endsWith('/conversations/counts')) return json({ tout: 1, aTraiter: 0, signalees: 0, archivees: 0, traitees: 0, nonAffectees: 1, parMembre: [] });
    if (chemin.endsWith('/conversations')) {
      // ⚠️ La liste ne rend le fil QUE s'il est demandé par son identifiant : c'est le cas réel d'un vieux
      // fil, hors de la première page. Sans le filtre, l'Inbox ne doit pas le trouver.
      const conv = { id: CONV, waId: '33600000001', profileName: 'Anna Nouvelle', lastPreview: null, lastMessageAt: '2026-09-23T10:00:00.000Z', controlOwner: 'app_human', unread: false, assignedTo: null, assignedToName: null };
      return json({ conversations: url.includes(`id=${CONV}`) ? [conv] : [] });
    }
    if (chemin.includes('/messages')) return json({ messages: [] });
    if (chemin.endsWith('/user-fields')) return json({ fields: [] });
    if (chemin.endsWith('/tags')) return json({ tags: [] });
    if (chemin.endsWith('/members')) return json({ members: [] });
    if (chemin.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (chemin.endsWith('/contacts')) return json({ contacts: [CONTACT], total: 1 });
    return json({});
  });
  await page.goto('/contacts');
  await page.getByText('Anna Nouvelle').first().click();
}

test.describe('Mini-CRM : ouvrir la conversation d un contact', () => {
  test('🔴 le bouton emmène sur LE fil du contact, identifiant compris', async ({ page }) => {
    await mock(page);
    await page.getByTestId('fiche-ouvrir-conversation').click();
    await expect(page).toHaveURL(new RegExp(`/inbox\\?c=${CONV}`));
  });

  test('🔴 et l Inbox OUVRE ce fil, même absent de la page chargée', async ({ page }) => {
    // Le cas d'un fil ancien : la liste ne le contient pas, et le lien était ignoré en silence.
    await mock(page);
    await page.getByTestId('fiche-ouvrir-conversation').click();
    await expect(page.getByText('Anna Nouvelle').first()).toBeVisible();
  });

  test('🔴 un contact sans identité joignable -> le refus est ÉCRIT, pas avalé', async ({ page }) => {
    await mock(page, 404);
    await page.getByTestId('fiche-ouvrir-conversation').click();
    await expect(page.getByTestId('fiche-ouvrir-erreur')).toBeVisible();
    await expect(page).not.toHaveURL(/\/inbox/);
  });

  test('une API pas encore déployée le dit aussi, et la fiche reste ouverte', async ({ page }) => {
    await mock(page, 503);
    await page.getByTestId('fiche-ouvrir-conversation').click();
    await expect(page.getByTestId('fiche-ouvrir-erreur')).toBeVisible();
    // La fiche n'est pas fermée : on peut réessayer, ou faire autre chose.
    await expect(page.getByTestId('fiche-ouvrir-conversation')).toBeVisible();
  });
});
