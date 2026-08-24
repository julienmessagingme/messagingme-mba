import { test, expect } from '@playwright/test';

/**
 * Contenu > Messages RCS : composer un message avec ses boutons, le voir dans l'aperçu, et l'enregistrer.
 *
 * Ce qu'on protège : le corps REELLEMENT posté. Un message enregistré sans ses boutons, ou avec un
 * `postbackData` vide, produirait un scénario incapable de router le clic du contact.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

async function mock(page: import('@playwright/test').Page, posts: Array<Record<string, unknown>>) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && url.includes('/rcs-messages')) {
      posts.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ message: { id: 'm1', name: 'x', content: null, createdAt: '', updatedAt: '' } }) });
    }
    if (url.includes('/rcs-messages')) return json({ messages: [] });
    if (url.includes('/user-fields')) {
      return json({ fields: [
        { key: 'prenom', label: 'Prénom', type: 'text' },
        { key: 'ville', label: 'Ville', type: 'text' },
        { key: 'date_rdv', label: 'Date du RDV', type: 'datetime' },
        { key: 'jour_visite', label: 'Jour de visite', type: 'date' },
      ] });
    }
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Contenu : messages RCS', () => {
  test('compose un message avec boutons, l affiche en apercu et poste le bon corps', async ({ page }) => {
    const posts: Array<Record<string, unknown>> = [];
    await mock(page, posts);
    await page.goto('/rcs-messages');

    await page.getByTestId('rcs-message-new').click();
    await page.getByTestId('rcs-message-name').fill('Offre du jour');
    await page.getByTestId('rcs-message-text').fill('Bonjour, votre offre est disponible.');

    await page.getByTestId('rcs-message-add-button').click();
    await page.getByPlaceholder('Libellé du bouton').fill('En savoir plus');

    // L'apercu montre le texte ET le bouton, avant tout enregistrement.
    await expect(page.getByTestId('rcs-preview-text')).toHaveText('Bonjour, votre offre est disponible.');
    await expect(page.getByTestId('rcs-preview-buttons')).toContainText('En savoir plus');

    await page.getByTestId('rcs-message-save').click();

    await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(1);
    expect(posts[0]).toMatchObject({
      name: 'Offre du jour',
      content: {
        kind: 'text',
        text: 'Bonjour, votre offre est disponible.',
        suggestions: [{ kind: 'reply', text: 'En savoir plus', postbackData: 'btn_1' }],
      },
    });
  });

  test('n enregistre PAS un bouton lien sans URL', async ({ page }) => {
    const posts: Array<Record<string, unknown>> = [];
    await mock(page, posts);
    await page.goto('/rcs-messages');

    await page.getByTestId('rcs-message-new').click();
    await page.getByTestId('rcs-message-name').fill('Avec lien');
    await page.getByTestId('rcs-message-text').fill('Bonjour');
    await page.getByTestId('rcs-message-add-button').click();
    await page.getByPlaceholder('Libellé du bouton').fill('Voir le site');
    await page.locator('select').first().selectOption('openUrl');

    // URL laissee vide : le bouton d'enregistrement doit rester inactif.
    await expect(page.getByTestId('rcs-message-save')).toBeDisabled();
    expect(posts).toHaveLength(0);
  });

  /**
   * L'image d'en-tete change le FORMAT du message envoye : texte -> carte. C'est la bascule qui compte, et
   * elle doit se voir dans le corps poste, pas seulement a l'ecran.
   */
  test('avec une image, poste une CARTE, boutons sous le message', async ({ page }) => {
    const posts: Array<Record<string, unknown>> = [];
    await mock(page, posts);
    await page.goto('/rcs-messages');

    await page.getByTestId('rcs-message-new').click();
    await page.getByTestId('rcs-message-name').fill('Offre visuelle');
    await page.getByTestId('rcs-message-image').fill('https://exemple.test/visuel.jpg');
    await page.getByTestId('rcs-message-text').fill('Notre offre du moment');
    await page.getByTestId('rcs-message-add-button').click();
    await page.getByPlaceholder('Libellé du bouton').fill('Je veux voir');

    // L'apercu montre l'image AU-DESSUS du texte, comme sur le telephone.
    await expect(page.getByTestId('rcs-preview-image')).toHaveAttribute('src', 'https://exemple.test/visuel.jpg');

    await page.getByTestId('rcs-message-save').click();
    await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(1);
    expect(posts[0]).toMatchObject({
      name: 'Offre visuelle',
      content: {
        kind: 'card',
        card: { description: 'Notre offre du moment', mediaUrl: 'https://exemple.test/visuel.jpg', mediaHeight: 'TALL' },
        suggestions: [{ kind: 'reply', text: 'Je veux voir', postbackData: 'btn_1' }],
      },
    });
  });

  test('AVERTIT sur une image dont l extension sera refusee par l operateur', async ({ page }) => {
    await mock(page, []);
    await page.goto('/rcs-messages');
    await page.getByTestId('rcs-message-new').click();
    await page.getByTestId('rcs-message-image').fill('https://exemple.test/visuel.webp');
    await expect(page.getByTestId('rcs-message-image-warn')).toBeVisible();
    await page.getByTestId('rcs-message-image').fill('https://exemple.test/visuel.png');
    await expect(page.getByTestId('rcs-message-image-warn')).toHaveCount(0);
  });

  test('insere une variable et un emoji AU CURSEUR, et poste le texte tel quel', async ({ page }) => {
    const posts: Array<Record<string, unknown>> = [];
    await mock(page, posts);
    await page.goto('/rcs-messages');

    await page.getByTestId('rcs-message-new').click();
    await page.getByTestId('rcs-message-name').fill('Avec variables');
    const zone = page.getByTestId('rcs-message-text');
    await zone.fill('Bonjour ');
    await page.getByTestId('rcs-message-var-prenom').click();
    await zone.pressSequentially(' !');
    await page.getByTestId('rcs-message-emoji-toggle').click();
    await page.getByRole('button', { name: '🎉', exact: true }).click();

    await expect(zone).toHaveValue('Bonjour {{prenom}} !🎉');
    await page.getByTestId('rcs-message-save').click();
    await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(1);
    expect(posts[0]).toMatchObject({ content: { kind: 'text', text: 'Bonjour {{prenom}} !🎉' } });
  });

  // Les champs de type ATTRIBUT (nom, wa_id) ne sont PAS dans la table de substitution du serveur : les
  // proposer afficherait du vide sur le telephone du contact.
  test('ne propose que les variables que le serveur sait resoudre', async ({ page }) => {
    await mock(page, []);
    await page.goto('/rcs-messages');
    await page.getByTestId('rcs-message-new').click();
    await expect(page.getByTestId('rcs-message-var-prenom')).toBeVisible();
    await expect(page.getByTestId('rcs-message-var-ville')).toBeVisible();
    await expect(page.getByTestId('rcs-message-var-wa_id')).toHaveCount(0);
  });

  test('compose un bouton Agenda a date fixe et poste ses champs', async ({ page }) => {
    const posts: Array<Record<string, unknown>> = [];
    await mock(page, posts);
    await page.goto('/rcs-messages');

    await page.getByTestId('rcs-message-new').click();
    await page.getByTestId('rcs-message-name').fill('Rappel de RDV');
    await page.getByTestId('rcs-message-text').fill('Votre rendez-vous approche.');
    await page.getByTestId('rcs-message-add-button').click();
    await page.getByTestId('rcs-bouton-kind-0').selectOption('calendar');
    await page.getByPlaceholder('Libellé du bouton').fill('Ajouter a mon agenda');
    await page.getByTestId('rcs-bouton-titre-0').fill('Rendez-vous conseiller');

    // Tant que les dates manquent, le bouton est incomplet : le serveur refuserait le message ENTIER, donc
    // l'ecran bloque l'enregistrement plutot que de laisser decouvrir l'erreur a l'envoi.
    await expect(page.getByTestId('rcs-message-save')).toBeDisabled();

    await page.getByTestId('rcs-bouton-debut-0-mode').selectOption('fixe');
    await page.getByTestId('rcs-bouton-debut-0').fill('2026-09-01T10:00');
    await page.getByTestId('rcs-bouton-fin-0-mode').selectOption('fixe');
    await page.getByTestId('rcs-bouton-fin-0').fill('2026-09-01T11:00');

    await page.getByTestId('rcs-message-save').click();
    await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(1);
    expect(posts[0]).toMatchObject({
      content: {
        kind: 'text',
        suggestions: [{
          kind: 'calendar',
          text: 'Ajouter a mon agenda',
          title: 'Rendez-vous conseiller',
          startAt: '2026-09-01T10:00',
          endAt: '2026-09-01T11:00',
        }],
      },
    });
  });

  /**
   * Le rendez-vous de CHAQUE contact. Un message de bibliotheque est reutilisable : une date en dur y serait
   * vraie une fois et fausse ensuite. Seuls les champs << date et heure >> sont proposes, parce qu'un champ
   * << date >> seule ne porte pas d'heure et produirait une valeur que le fournisseur refuse.
   */
  test('un bouton Agenda peut prendre sa date dans la fiche du contact', async ({ page }) => {
    const posts: Array<Record<string, unknown>> = [];
    await mock(page, posts);
    await page.goto('/rcs-messages');

    await page.getByTestId('rcs-message-new').click();
    await page.getByTestId('rcs-message-name').fill('RDV par contact');
    await page.getByTestId('rcs-message-text').fill('A demain.');
    await page.getByTestId('rcs-message-add-button').click();
    await page.getByTestId('rcs-bouton-kind-0').selectOption('calendar');
    await page.getByPlaceholder('Libellé du bouton').fill('Mon rendez-vous');
    await page.getByTestId('rcs-bouton-titre-0').fill('Visite');
    await page.getByTestId('rcs-bouton-debut-0-mode').selectOption('champ');
    await page.getByTestId('rcs-bouton-fin-0-mode').selectOption('champ');

    // Le selecteur ne propose QUE le champ date-heure, jamais le champ date seule.
    const options = await page.getByTestId('rcs-bouton-debut-0').locator('option').allTextContents();
    expect(options).toEqual(['Date du RDV']);

    await page.getByTestId('rcs-message-save').click();
    await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(1);
    expect(posts[0]).toMatchObject({
      content: { suggestions: [{ kind: 'calendar', startAt: '{{date_rdv}}', endAt: '{{date_rdv}}' }] },
    });
  });

  test('compose un bouton Voir un lieu et un bouton Demander sa position', async ({ page }) => {
    const posts: Array<Record<string, unknown>> = [];
    await mock(page, posts);
    await page.goto('/rcs-messages');

    await page.getByTestId('rcs-message-new').click();
    await page.getByTestId('rcs-message-name').fill('Notre agence');
    await page.getByTestId('rcs-message-text').fill('Passez nous voir.');

    await page.getByTestId('rcs-message-add-button').click();
    await page.getByTestId('rcs-bouton-kind-0').selectOption('showLocation');
    await page.getByPlaceholder('Libellé du bouton').first().fill('Voir l agence');
    await page.getByPlaceholder('Latitude (48.8566)').fill('48.8566');
    await page.getByPlaceholder('Longitude (2.3522)').fill('2.3522');
    await page.getByPlaceholder('Nom du lieu').fill('Agence Paris');

    await page.getByTestId('rcs-message-add-button').click();
    await page.getByTestId('rcs-bouton-kind-1').selectOption('requestLocation');
    await page.getByPlaceholder('Libellé du bouton').nth(1).fill('Envoyer ma position');

    await page.getByTestId('rcs-message-save').click();
    await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(1);
    expect(posts[0]).toMatchObject({
      content: {
        suggestions: [
          { kind: 'showLocation', text: 'Voir l agence', latitude: 48.8566, longitude: 2.3522, label: 'Agence Paris' },
          { kind: 'requestLocation', text: 'Envoyer ma position' },
        ],
      },
    });
  });
});
