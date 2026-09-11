import { test, expect } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * E2E : le contrôle du fil ne se règle plus conversation par conversation.
 *
 * Ce fichier REMPLACE le test de la surcharge de reprise par conversation (« À la reprise : défaut du compte /
 * repart au scénario / reste à traiter »), supprimée avec la migration 0059. Il n'est pas jeté mais retourné :
 * là où il vérifiait que le sélecteur écrivait le bon réglage, il vérifie maintenant qu'il n'existe PLUS, et
 * que le seul réglage restant, le délai, n'a qu'un unique endroit (MBA > Paramètres > Activation).
 *
 * Pourquoi c'est un test et pas une simple suppression : la simplification est la fonctionnalité. Si quelqu'un
 * réintroduit un choix par conversation, la règle « le délai décide seul » redevient fausse en silence.
 *
 * ⚠️ Le fichier couvre DEPUIS LE 2026-09-08 le seul geste qui reste sur le contrôle du fil : reprendre la
 * main, quel que soit son détenteur. Le délai n'était pas la seule sortie possible, il était la seule sortie
 * OFFERTE face à l'agent de Meta, et c'est ce trou que les cas du bas gardent.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const CONV = { id: 'c1', waId: '33600000001', profileName: 'Alice Retour', lastPreview: 'coucou', lastMessageAt: '2026-08-02T10:00:00Z', controlOwner: 'app_human' };
const THREAD = {
  waId: '33600000001', windowOpen: true, lastInboundAt: '2026-08-02T10:00:00Z', controlOwner: 'app_human',
  messages: [{ id: 'm1', direction: 'in', type: 'text', body: 'coucou', buttonPayload: null, createdAt: '2026-08-02T10:00:00Z' }],
};
const REGLAGES = { mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} };

test.describe('Contrôle du fil : un seul réglage, à un seul endroit', () => {
  test('🔴 l’Inbox n’offre PLUS de choix de reprise par conversation', async ({ page }) => {
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    const appels: string[] = [];
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      appels.push(`${route.request().method()} ${url}`);
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.endsWith('/c1/messages')) return json(THREAD);
      if (url.split('?')[0]!.endsWith('/conversations')) return json({ conversations: [CONV] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await page.goto('/inbox');
    // La vignette ouvre la conversation. Le clic sur le NOM ouvre desormais la fiche du contact : ce sont
    // deux gestes distincts depuis le lot du 2026-08-21.
    await page.getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).click();
    // Le fil s'ouvre bel et bien : sans cette assertion, un écran cassé passerait pour un écran sans sélecteur.
    await expect(page.getByText(/fenêtre 24 h ouverte|24h window open/)).toBeVisible();

    await expect(page.getByTestId('thread-return-select')).toHaveCount(0);
    expect(appels.filter((a) => a.includes('return-behavior'))).toEqual([]);
  });

  /**
   * 🔴 UN FIL PRIS PAR L'AGENT DE META DOIT AVOIR UNE SORTIE DEPUIS LA CONSOLE (2026-09-08).
   *
   * Le bouton ne sortait que sur `app_human`, alors que la route rend la main quel que soit le détenteur.
   * Conséquence vécue le 2026-09-08 : le fil de Julien était à `mba` depuis la veille, aucun déclencheur
   * automatique n'y écrivait, et son bouton de chaîne ne lançait rien alors que le mot-clé correspondait et
   * que l'automation était bien trouvée. La seule sortie était le délai d'inactivité, soit 24 h d'attente.
   */
  /**
   * 🔴 LA ROUTE FAIT PARTIE DU CAS DEPUIS LE 2026-09-11. Ce test affirmait que les DEUX sens partaient sur
   * `/release`, et c'est précisément le bug qu'il figeait : sur un fil tenu par l'agent de Meta,
   * « Reprendre la main » demandait à Meta de le GARDER. Le cas exercé est conservé (le bouton sort, porte
   * le bon libellé, et appelle le serveur une fois) ; ce qui change est l'adresse attendue, qui est
   * désormais celle du geste et non celle de son contraire.
   */
  for (const cas of [
    { owner: 'app_human', bouton: /Rendre la main|Hand back/, route: /POST .*\/release$/, autre: /POST .*\/prendre$/ },
    { owner: 'mba', bouton: /Reprendre la main|Take back/, route: /POST .*\/prendre$/, autre: /POST .*\/release$/ },
  ] as const) {
    test(`un fil tenu par « ${cas.owner} » se bascule depuis l’Inbox, par SA route`, async ({ page }) => {
      await page.addInitScript((sess) => window.localStorage.setItem('mba.session', JSON.stringify(sess)), SESSION);
      const appels: string[] = [];
      await page.route('**/api/backend/**', async (route) => {
        const url = route.request().url();
        appels.push(`${route.request().method()} ${url}`);
        const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
        if (/\/release$/.test(url)) return json({ controlOwner: 'app_workflow' });
        if (/\/prendre$/.test(url)) return json({ controlOwner: 'app_human' });
        if (url.endsWith('/c1/messages')) return json({ ...THREAD, controlOwner: cas.owner });
        if (url.split('?')[0]!.endsWith('/conversations')) return json({ conversations: [{ ...CONV, controlOwner: cas.owner }] });
        if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
        return json({});
      });
      await page.goto('/inbox');
      await page.getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).click();
      // Le libellé n'est pas le même dans les deux sens : un opérateur REND une main qu'il a prise, alors
      // qu'on la PREND à l'agent de Meta. Deux gestes opposés, deux adresses.
      await expect(page.getByTestId('inbox-rendre-la-main')).toHaveText(cas.bouton);
      await page.getByTestId('inbox-rendre-la-main').click();
      await expect.poll(() => appels.filter((a) => cas.route.test(a)).length, { timeout: 5000 }).toBe(1);
      // ⚠️ La preuve INVERSE, sans laquelle appeler les deux routes passerait le test : le geste contraire
      // n'est jamais parti.
      expect(appels.filter((a) => cas.autre.test(a))).toEqual([]);
    });
  }

  test('🔴 Meta refuse de céder le fil : l’écran DIT la porte de secours', async ({ page }) => {
    // Meta réserve l'action `take` au « configured escalation partner » : le refus est un cas normal. Un
    // repli générique (« Reprise impossible ») effacerait la seule chose utile de ce message, à savoir que
    // ÉCRIRE prend le fil à coup sûr.
    await page.addInitScript((sess) => window.localStorage.setItem('mba.session', JSON.stringify(sess)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
      if (/\/prendre$/.test(url)) {
        return json({ error: 'Meta n’a pas cédé la conversation, son agent peut encore répondre. Envoyez un message : écrire prend le fil à coup sûr.' }, 409);
      }
      if (url.endsWith('/c1/messages')) return json({ ...THREAD, controlOwner: 'mba' });
      if (url.split('?')[0]!.endsWith('/conversations')) return json({ conversations: [{ ...CONV, controlOwner: 'mba' }] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/inbox');
    await page.getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).click();
    await page.getByTestId('inbox-rendre-la-main').click();
    await expect(page.getByText(/Envoyez un message/)).toBeVisible({ timeout: 5000 });
  });

  test('🔴 preuve inverse : un fil déjà au scénario n’offre PAS le bouton', async ({ page }) => {
    // Sans ce cas, afficher le bouton en permanence passerait le test ci-dessus, et l'écran proposerait de
    // reprendre une main que l'app détient déjà.
    await page.addInitScript((sess) => window.localStorage.setItem('mba.session', JSON.stringify(sess)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.endsWith('/c1/messages')) return json({ ...THREAD, controlOwner: 'app_workflow' });
      if (url.split('?')[0]!.endsWith('/conversations')) return json({ conversations: [{ ...CONV, controlOwner: 'app_workflow' }] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/inbox');
    await page.getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).click();
    await expect(page.getByText(/fenêtre 24 h ouverte|24h window open/)).toBeVisible();
    await expect(page.getByTestId('inbox-rendre-la-main')).toHaveCount(0);
  });

  test('le délai de reprise n’a qu’UN seul endroit, et ce n’est ni l’inbox ni l’accueil', async ({ page }) => {
    // Le délai a rejoint MBA > Paramètres > Activation. Ce que ce test protège ici, c'est son UNICITÉ : deux
    // champs qui écrivent le même réglage à deux endroits, c'est la porte ouverte à deux valeurs affichées.
    // La saisie elle-même (minutes à l'écran, secondes sur le fil) est vérifiée par `mba-activation.spec.ts`.
    await mockAccueil(page);
    await expect(page.getByTestId('handback-input')).toHaveCount(0);
    await expect(page.getByTestId('return-behavior-select')).toHaveCount(0);
    await expect(page.getByTestId('lien-activation')).toBeVisible();
  });
});

test.describe('Qui tient le fil se voit dans la LISTE, sans se lire', () => {
  /**
   * Demande de Julien, le 2026-09-11 : « remplir les frames qui contiennent les Noms des personnes d'une
   * autre couleur, genre bleu clair un peu fuzzy ou dégradé pour ceux qui sont en cours de MBA avec qq
   * petites étoiles ou genre baguette magique [...] et du coup plus besoin de mettre dans le frame la
   * mention "agent Meta" ».
   */
  const LIGNES = [
    { ...CONV, id: 'c1', profileName: 'Tenue par Meta', controlOwner: 'mba' },
    { ...CONV, id: 'c2', waId: '33600000002', profileName: 'Tenue par un humain', controlOwner: 'app_human' },
    { ...CONV, id: 'c3', waId: '33600000003', profileName: 'Au scénario', controlOwner: 'app_workflow' },
  ];

  async function poser(page: import('@playwright/test').Page) {
    await page.addInitScript((sess) => window.localStorage.setItem('mba.session', JSON.stringify(sess)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.split('?')[0]!.endsWith('/conversations')) return json({ conversations: LIGNES });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/inbox');
  }

  test('🔴 un fil tenu par Meta porte la baguette, et PLUS la mention texte', async ({ page }) => {
    await poser(page);
    await expect(page.getByTestId('inbox-baguette-c1')).toBeVisible();
    // La mention texte a disparu de la LISTE : c'est la demande, le dégradé et la baguette la remplacent.
    await expect(page.getByText('agent Meta', { exact: true })).toHaveCount(0);
    // ⚠️ Mais l'information reste accessible à qui ne voit pas la couleur.
    await expect(page.getByTestId('inbox-baguette-c1')).toHaveAttribute('aria-label', /agent Meta|Meta agent/);
  });

  test('🔴 preuves inverses : les autres lignes ne sont ni colorées ni baguettées', async ({ page }) => {
    // Sans elles, colorer TOUTES les lignes passerait le test ci-dessus, et le coup d'œil ne dirait plus rien.
    await poser(page);
    await expect(page.getByTestId('inbox-ligne-c1')).toHaveAttribute('data-mba', 'oui');
    for (const id of ['c2', 'c3']) {
      await expect(page.getByTestId(`inbox-ligne-${id}`)).not.toHaveAttribute('data-mba', 'oui');
      await expect(page.getByTestId(`inbox-baguette-${id}`)).toHaveCount(0);
    }
    // Le fil tenu par un HUMAIN garde sa mention texte : elle n'a pas de couleur pour la remplacer.
    await expect(page.getByText(/vous avez la main|you have the hand/)).toBeVisible();
  });
});
