import { test, expect } from '@playwright/test';

/**
 * Tools > Webhooks : recevoir un JSON d'un outil tiers et dire où va chaque valeur.
 *
 * Le coeur de l'écran est le deuxième temps du parcours : tant qu'aucun appel n'est arrivé, il n'y a rien à
 * mapper, et l'écran doit le DIRE au lieu d'afficher un formulaire vide dans lequel on ne sait pas quoi
 * saisir.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const PAYLOAD = {
  client: { tel: '+33612345678', nom: 'Marie Durand', note: null },
  lignes: [{ prix: 42.5, ref: 'A-1' }],
  'cle.avec.points': 'inadressable',
};

const BASE = {
  id: 'wh1', name: 'Formulaire du site', enabled: true, code: 'ab12cd34ef56gh78jk90mn12pq',
  url: 'https://mba.messagingme.app/api/backend/w/ab12cd34ef56gh78jk90mn12pq',
  hasSecret: false, mapping: [] as Array<{ chemin: string; cible: string }>, createContact: true,
  workflowId: null as string | null, startNodeId: null, cooldownSeconds: null,
  lastPayload: null as unknown, lastReceivedAt: null as string | null, contactsCreated: 0,
  createdAt: '2026-08-20T09:00:00.000Z',
};

interface Etat { patchs: Array<Record<string, unknown>>; crees: Array<Record<string, unknown>> }

async function monter(page: import('@playwright/test').Page, hook: Record<string, unknown> | null): Promise<Etat> {
  const etat: Etat = { patchs: [], crees: [] };
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });

    if (url.includes('/webhooks')) {
      if (method === 'POST' && url.endsWith('/secret')) return json({ secret: 'whk_le_clair_du_secret', entete: 'X-Webhook-Secret' }, 201);
      if (method === 'POST') { etat.crees.push(JSON.parse(route.request().postData() ?? '{}')); return json({ id: 'wh1', code: BASE.code, url: BASE.url }, 201); }
      if (method === 'PATCH') { etat.patchs.push(JSON.parse(route.request().postData() ?? '{}')); return json({ id: 'wh1' }); }
      if (method === 'DELETE') return route.fulfill({ status: 204, body: '' });
      return json({ webhooks: hook ? [hook] : [] });
    }
    if (url.includes('/user-fields')) return json({ fields: [{ key: 'ville', label: 'Ville', type: 'text' }, { key: 'montant', label: 'Montant', type: 'text' }] });
    if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Relance devis' }] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
  await page.goto('/webhooks');
  return etat;
}

test.describe('Webhooks : le menu et la liste', () => {
  test('🔴 l’entrée Tools > Webhooks de la barre latérale mène à l’écran', async ({ page }) => {
    // Demande explicite de Julien : un nouveau menu « Tools » dans la barre. Naviguer directement vers
    // /webhooks ne prouverait rien de ce menu.
    await monter(page, null);
    await page.goto('/accueil');
    await page.getByRole('button', { name: /^Tools$/ }).click();
    await page.getByRole('link', { name: /^Webhooks$/ }).click();
    await expect(page).toHaveURL(/\/webhooks$/);
    await expect(page.getByRole('heading', { name: 'Webhooks' })).toBeVisible();
  });

  test('sans aucun webhook, l’écran le dit', async ({ page }) => {
    await monter(page, null);
    await expect(page.getByText(/Aucun webhook|No webhooks yet/)).toBeVisible();
  });

  test('créer un webhook ouvre directement son détail, avec l’adresse à copier', async ({ page }) => {
    // C'est la seule chose dont l'utilisateur a besoin à cet instant : l'URL à coller dans son outil.
    const etat = await monter(page, BASE);
    await page.getByTestId('webhook-nom').fill('Formulaire du site');
    await page.getByRole('button', { name: /^Créer$|^Create$/ }).click();
    await expect(page.getByTestId('webhook-url')).toHaveText(BASE.url);
    expect(etat.crees[0]).toMatchObject({ name: 'Formulaire du site' });
  });
});

test.describe('Webhooks : avant le premier appel', () => {
  test('🔴 l’écran DIT qu’il attend un appel, au lieu d’un formulaire vide', async ({ page }) => {
    await monter(page, BASE);
    await page.getByRole('button', { name: 'Formulaire du site' }).click();
    await expect(page.getByTestId('attente-premier-appel')).toBeVisible();
    await expect(page.getByTestId('arbre-json')).toHaveCount(0);
  });

  test('🔴 l’absence de téléphone est signalée AVANT, pas au moment où rien ne se passe', async ({ page }) => {
    await monter(page, BASE);
    await page.getByRole('button', { name: 'Formulaire du site' }).click();
    await expect(page.getByTestId('alerte-telephone')).toContainText(/Téléphone|Phone/);
  });
});

test.describe('Webhooks : mapper le JSON reçu', () => {
  const avecPayload = { ...BASE, lastPayload: PAYLOAD, lastReceivedAt: '2026-08-23T10:00:00.000Z' };

  test('l’arbre montre le contenu reçu', async ({ page }) => {
    await monter(page, avecPayload);
    await page.getByRole('button', { name: 'Formulaire du site' }).click();
    const arbre = page.getByTestId('arbre-json');
    await expect(arbre).toContainText('client');
    await expect(arbre).toContainText('+33612345678');
    await expect(arbre).toContainText('lignes');
  });

  test('🔴 le premier « Attacher » va sur Téléphone, et l’alerte disparaît', async ({ page }) => {
    // Sans téléphone le webhook ne peut ni retrouver ni créer de contact : c'est la première chose à mapper.
    await monter(page, avecPayload);
    await page.getByRole('button', { name: 'Formulaire du site' }).click();
    await page.getByTestId('arbre-json').locator('[data-cle="tel"]').getByRole('button', { name: /Attacher|Attach/ }).click();
    await expect(page.getByTestId('liste-mapping')).toContainText('client.tel');
    await expect(page.getByTestId('alerte-telephone')).toHaveCount(0);
  });

  test('🔴 un objet et un tableau ne sont PAS attachables', async ({ page }) => {
    // Une valeur non scalaire écrite dans un champ rendrait la variable VIDE dans un template, sans erreur.
    await monter(page, avecPayload);
    await page.getByRole('button', { name: 'Formulaire du site' }).click();
    for (const cle of ['client', 'lignes']) {
      const ligne = page.getByTestId('arbre-json').locator(`[data-cle="${cle}"]`);
      // La ligne DOIT exister : sans cette assertion, un sélecteur qui ne trouve rien ferait passer le test
      // en annonçant une garantie qu'il n'apporte pas.
      await expect(ligne, cle).toBeVisible();
      await expect(ligne.getByRole('button', { name: /Attacher|Attach/ }), cle).toHaveCount(0);
    }
  });

  test('🔴 une valeur `null` n’est pas attachable non plus (une absence n’est pas une valeur)', async ({ page }) => {
    await monter(page, avecPayload);
    await page.getByRole('button', { name: 'Formulaire du site' }).click();
    const ligneNote = page.getByTestId('arbre-json').locator('[data-cle="note"]');
    await expect(ligneNote).toBeVisible();
    await expect(ligneNote).toContainText('null');
    await expect(ligneNote.getByRole('button', { name: /Attacher|Attach/ })).toHaveCount(0);
  });

  test('🔴 une clé contenant un point est AFFICHÉE mais signalée non adressable', async ({ page }) => {
    // La masquer ferait chercher une clé qu'on a pourtant bien reçue.
    await monter(page, avecPayload);
    await page.getByRole('button', { name: 'Formulaire du site' }).click();
    const arbre = page.getByTestId('arbre-json');
    const ligne = arbre.locator('[data-cle="cle.avec.points"]');
    await expect(ligne).toBeVisible();
    await expect(ligne).toContainText(/non adressable|not addressable/);
    await expect(ligne.getByRole('button', { name: /Attacher|Attach/ })).toHaveCount(0);
  });

  test('🔴 enregistrer envoie le mapping construit, pas autre chose', async ({ page }) => {
    const etat = await monter(page, avecPayload);
    await page.getByRole('button', { name: 'Formulaire du site' }).click();
    await page.getByTestId('arbre-json').locator('[data-cle="tel"]').getByRole('button', { name: /Attacher|Attach/ }).click();
    await page.getByTestId('select-scenario').selectOption('wf1');
    await page.getByTestId('enregistrer-webhook').click();
    await expect.poll(() => etat.patchs.length).toBeGreaterThan(0);
    expect(etat.patchs[0]).toMatchObject({
      mapping: [{ chemin: 'client.tel', cible: 'sys:phone' }],
      workflowId: 'wf1',
      createContact: true,
      enabled: true,
    });
  });
});

test.describe('Webhooks : le secret', () => {
  test('🔴 le clair s’affiche une fois, avec l’avertissement', async ({ page }) => {
    await monter(page, BASE);
    await page.getByRole('button', { name: 'Formulaire du site' }).click();
    await page.getByRole('button', { name: /Générer un secret|Generate a secret/ }).click();
    await expect(page.getByTestId('webhook-secret')).toHaveText('whk_le_clair_du_secret');
    await expect(page.getByText(/il ne sera plus jamais affiché|it will never be shown again/i)).toBeVisible();
  });
});
