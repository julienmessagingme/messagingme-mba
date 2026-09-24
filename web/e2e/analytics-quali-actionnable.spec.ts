import { test, expect } from '@playwright/test';

/**
 * Analytics QUALITATIF : rendre le tableau actionnable (demande de Julien du 2026-09-01).
 *
 * Quatre gestes, et un seul test possible pour chacun : ce sont des fenêtres et des filtres, donc rien de
 * tout cela ne se voit d'un test unitaire. Ce qui est vérifié n'est pas « la modale s'ouvre » mais ce que
 * l'ouverture PROMET : la liste derrière un chiffre porte bien le filtre du chiffre, une pastille de sujet
 * envoie son filtre AU SERVEUR (et pas un tri en mémoire sur les 50 lignes déjà là), et une conversation
 * analysée avant l'existence du résumé le DIT au lieu d'afficher la justification à sa place.
 *
 * Backend intercepté (aucune base), même patron que les autres specs d'analytics.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const RESUME = {
  enabled: true,
  retentionDays: 365,
  total: 3,
  sentiment: { positif: 1, neutre: 1, negatif: 1 },
  intent: { demande_devis: 2, sav: 1, reclamation: 0, information: 0, prise_rdv: 0, autre: 0 },
  resolution: { resolved: 2, unresolved: 1, rate: 2 / 3 },
  handledBy: { humain: 1, automatise: 2, mba: 0 },
  exchanges: { avg: 3.5, median: 3 },
  actions: { creer_devis: 2, rappeler: 1, relancer: 0, escalader: 0, aucune: 0 },
  topTopics: [{ topic: 'retard de livraison', count: 2 }, { topic: 'devis', count: 1 }],
  confidence: { lt50: 0, from50to70: 1, from70to90: 1, gte90: 1 },
};

function conv(over: Record<string, unknown> = {}) {
  return {
    conversationId: 'cv1',
    waId: '33600000001',
    profileName: 'Léa Martin',
    sentiment: 'negatif',
    intent: 'reclamation',
    topic: 'retard de livraison',
    resolved: false,
    actionSuggestion: 'rappeler',
    confidence: 0.87,
    justification: 'Client mécontent, à rappeler',
    handledBy: 'automatise',
    exchangesCount: 7,
    analyzedAt: '2026-08-30T09:15:00.000Z',
    inboxHref: '/inbox?c=cv1',
    summary: 'Le client signale un retard de trois jours. On lui a promis un suivi.',
    entities: { commande: 'A-42' },
    ...over,
  };
}

/** Capture les requêtes de liste : c'est là que se lit ce que l'écran a VRAIMENT demandé au serveur. */
async function mock(page: import('@playwright/test').Page, appels: string[], conversations: unknown[] = [conv()]) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/stats/conversations/list')) {
      appels.push(url);
      return json({ conversations });
    }
    if (url.includes('/stats/conversations')) return json(RESUME);
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Analytics qualitatif : le tableau devient actionnable', () => {
  test('🔴 le chiffre d une action suggérée OUVRE la liste, filtrée sur cette action', async ({ page }) => {
    // Le tableau annonçait « 2 devis à créer » sans dire lesquels : le chiffre ne menait à aucun geste.
    const appels: string[] = [];
    await mock(page, appels);
    await page.goto('/dashboard/quali');
    await expect(page.getByText('Action suggérée (pipeline)')).toBeVisible();

    await page.getByRole('button', { name: /Rappeler/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByTestId('liste-action-ligne')).toHaveCount(1);

    // C'est le SERVEUR qui filtre : la requête porte l'action cliquée.
    expect(appels.some((u) => u.includes('action=rappeler'))).toBe(true);

    // Et l'export de CETTE liste est proposé, pas seulement celui du tableau du dessous.
    await expect(page.getByTestId('csv-conversations-rappeler')).toBeVisible();
  });

  test('🔴 une action à ZÉRO n ouvre rien : une fenêtre vide se lirait comme une panne', async ({ page }) => {
    const appels: string[] = [];
    await mock(page, appels);
    await page.goto('/dashboard/quali');
    await expect(page.getByText('Action suggérée (pipeline)')).toBeVisible();
    // « Relancer » vaut 0 dans le résumé : la barre est là, mais elle n'est pas un bouton. On reste DANS le
    // bloc des actions : le libellé existe aussi dans le menu déroulant du tableau, plus bas.
    const actions = page.getByTestId('quali-actions');
    await expect(actions.getByRole('button', { name: /Relancer/ })).toHaveCount(0);
    await expect(actions.getByText('Relancer')).toBeVisible();
    // Et l'action non nulle juste à côté, elle, EST un bouton : sans ce second sens, le test passerait
    // aussi bien sur un écran où plus rien ne serait cliquable.
    await expect(actions.getByRole('button', { name: /Rappeler/ })).toBeVisible();
  });

  test('🔴 cliquer un SUJET filtre côté serveur, recliquer le relâche', async ({ page }) => {
    const appels: string[] = [];
    await mock(page, appels);
    await page.goto('/dashboard/quali');
    await expect(page.getByTestId('quali-ligne')).toHaveCount(1);
    const avant = appels.length;

    await page.getByTestId('quali-sujet-retard de livraison').click();
    // Le filtre part au serveur, encodé. Un tri en mémoire sur les 50 lignes déjà chargées aurait rendu une
    // liste plus courte que la réalité, sans que rien ne le dise.
    await expect.poll(() => appels.slice(avant).some((u) => u.includes('topic=retard%20de%20livraison'))).toBe(true);
    await expect(page.getByTestId('quali-sujet-retirer')).toBeVisible();

    const apresFiltre = appels.length;
    await page.getByTestId('quali-sujet-retard de livraison').click();
    await expect.poll(() => appels.slice(apresFiltre).some((u) => !u.includes('topic='))).toBe(true);
    await expect(page.getByTestId('quali-sujet-retirer')).toHaveCount(0);
  });

  test('🔴 une ligne du détail ouvre sa FICHE (résumé compris), et l inbox devient une décision', async ({ page }) => {
    const appels: string[] = [];
    await mock(page, appels);
    await page.goto('/dashboard/quali');
    await page.getByTestId('quali-ligne').click();

    const fiche = page.getByTestId('fiche-conversation');
    await expect(fiche).toBeVisible();
    await expect(page.getByTestId('fiche-resume')).toContainText('retard de trois jours');
    // La justification est là AUSSI, mais à sa place : elle ne remplace pas le résumé.
    await expect(fiche).toContainText('Client mécontent');
    await expect(fiche).toContainText('A-42'); // les infos relevées, jamais montrées avant

    // On ne part vers l'inbox que si on le décide.
    await expect(page).toHaveURL(/\/dashboard\/quali/);
    await page.getByTestId('fiche-vers-inbox').click();
    await expect(page).toHaveURL(/\/inbox\?c=cv1/);
  });

  test('🔴 une analyse SANS résumé le DIT, elle ne montre pas la justification à la place', async ({ page }) => {
    // Les analyses d'avant la migration 0100 n'ont pas de résumé et n'en auront jamais. Afficher la
    // justification à sa place serait un mensonge discret : elle explique le classement, pas le contenu.
    const appels: string[] = [];
    await mock(page, appels, [conv({ summary: null })]);
    await page.goto('/dashboard/quali');
    await page.getByTestId('quali-ligne').click();
    await expect(page.getByTestId('fiche-resume-absent')).toBeVisible();
    await expect(page.getByTestId('fiche-resume')).toHaveCount(0);
  });

  test('l écran ANNONCE la rétention, pour qu une liste courte ne passe pas pour un bug', async ({ page }) => {
    const appels: string[] = [];
    await mock(page, appels);
    await page.goto('/dashboard/quali');
    await expect(page.getByText(/conservées 365 jours/)).toBeVisible();
  });

  test('🔴 une rétention à ZÉRO dit « sans limite », pas « conservées 0 jours »', async ({ page }) => {
    // Zéro DÉSACTIVE la purge côté serveur (`CONVERSATION_RETENTION_DAYS`, et `purgeConversationsOlderThan`
    // qui rend 0 sans rien effacer). La phrase littérale dirait donc l'inverse exact de ce que fait le
    // produit, et cette phrase-là est précisément celle que l'utilisateur croira sur parole.
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/stats/conversations/list')) return json({ conversations: [conv()] });
      if (url.includes('/stats/conversations')) return json({ ...RESUME, retentionDays: 0 });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/dashboard/quali');
    await expect(page.getByText(/sans limite de durée/)).toBeVisible();
    await expect(page.getByText(/conservées 0 jours/)).toHaveCount(0);
  });

  test('🔴 une API qui ne connait pas les intentions neuves ne fait pas tomber la page', async ({ page }) => {
    // RESUME ne porte que les six intentions d avant le 2026-09-24 : c est exactement la reponse d une API
    // plus ancienne que la console. Sans repli a zero, `Math.max` rendrait NaN et `fmtNum(undefined)`
    // leverait une TypeError : la page entiere tomberait, pas seulement une barre.
    const appels: string[] = [];
    await mock(page, appels);
    await page.goto('/dashboard/quali');
    const bloc = page.getByTestId('quali-intentions');
    await expect(bloc).toContainText('Demande de devis');
    await expect(bloc).toContainText('Suivi de commande');
    await expect(bloc).not.toContainText('NaN');
  });
});
