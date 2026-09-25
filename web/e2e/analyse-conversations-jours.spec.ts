import { test, expect } from '@playwright/test';

/**
 * L ECRAN « ANALYSE DES CONVERSATIONS » : une ligne par JOUR, et qui a repondu.
 *
 * 🔴 CE QUE CE FICHIER PROTEGE. Deux choses que l oeil ne verifie pas :
 *  - une case VIDE n est pas un ZERO. Zero est une note valide et la PIRE de toutes : confondre les deux
 *    rangerait tout l historique d avant la migration 0121 dans le coin « clients furieux » ;
 *  - les badges se derivent de `conversation_messages.origin`, PAS de `handled_by`, qui ne rend que
 *    'humain' ou 'automatise' et dont la valeur 'mba' n est JAMAIS produite (mesure en production le
 *    2026-09-17 : zero ligne sur 14). Une conversation menee par l agent de Meta y serait indiscernable
 *    d un scenario, ce qui est exactement la distinction demandee par Julien.
 */
const ADMIN = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const RESUME = {
  enabled: true, retentionDays: 90, total: 8,
  sentiment: { positif: 3, neutre: 3, negatif: 2 },
  intent: { demande_devis: 0, sav: 0, reclamation: 0, information: 5, prise_rdv: 2, autre: 1 },
  resolution: { resolved: 5, unresolved: 3, rate: 0.625 },
  handledBy: { humain: 3, automatise: 5, mba: 0 },
  exchanges: { avg: 3, median: 3 },
  actions: { creer_devis: 0, rappeler: 1, relancer: 0, escalader: 0, aucune: 7 },
  topTopics: [{ topic: 'tarifs', count: 3 }],
  topicsParIntention: { information: [{ topic: 'tarifs', count: 3 }] },
  confidence: { lt50: 0, from50to70: 1, from70to90: 3, gte90: 4 },
};

const JOURS = [
  // Une journee MESUREE, et une journee qui ne l est pas : les deux cas du meme tableau.
  { jour: '2026-09-16', conversations: 3, satisfaction: 7.5, urgence: 4, mesurees: 2 },
  { jour: '2026-09-15', conversations: 5, satisfaction: null, urgence: null, mesurees: 0 },
];

const CONV = (id: string, origines: string[]) => ({
  conversationId: id, waId: '33600000001', profileName: 'Lea', sentiment: 'positif', intent: 'information',
  topic: 'tarifs', resolved: true, actionSuggestion: 'aucune', confidence: 0.9, justification: 'j',
  handledBy: 'automatise', exchangesCount: 2, analyzedAt: '2026-09-16T10:00:00.000Z',
  inboxHref: '/inbox?c=' + id, summary: 'Resume', entities: {}, origines,
});

async function mock(page: import('@playwright/test').Page, opts: { jours?: unknown; conversations?: unknown[]; statutJours?: number } = {}) {
  const plages: string[] = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), ADMIN);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    // ⚠️ LES JOURS AVANT LE RESUME : les deux adresses commencent par `/stats/conversations`, et l inverse
    // ferait servir le resume au tableau des jours. C est le genre d ordre qui rend un test vert pour la
    // mauvaise raison.
    if (url.includes('/stats/conversations/jours')) {
      if (opts.statutJours && opts.statutJours !== 200) {
        return route.fulfill({ status: opts.statutJours, contentType: 'application/json', body: JSON.stringify({ error: 'nope' }) });
      }
      return json({ jours: opts.jours ?? JOURS });
    }
    if (url.includes('/stats/conversations/list')) {
      plages.push(url);
      return json({ conversations: opts.conversations ?? [CONV('cv1', ['humain', 'mba'])] });
    }
    if (url.includes('/stats/conversations')) return json(RESUME);
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: ADMIN.email, name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
  return { plages };
}

test.describe('Analyse des conversations : une ligne par jour', () => {
  test('le tableau des journees s affiche, avec ses moyennes', async ({ page }) => {
    await mock(page);
    await page.goto('/dashboard/quali');
    await expect(page.getByTestId('jours-analyse')).toBeVisible();
    await expect(page.getByTestId('jour-ligne-2026-09-16')).toBeVisible();
    await expect(page.getByTestId('jour-satisfaction-2026-09-16')).toContainText('7,5');
  });

  test('🔴 une journee SANS mesure affiche une case VIDE, jamais un zero', async ({ page }) => {
    // Zero est une note VALIDE et la pire de toutes. Les analyses d avant la migration 0121 n en ont
    // aucune : les placer a zero rangerait tout l historique dans le coin « clients furieux ».
    await mock(page);
    await page.goto('/dashboard/quali');
    await expect(page.getByTestId('jour-satisfaction-2026-09-15')).toHaveText('n/d');
    await expect(page.getByTestId('jour-urgence-2026-09-15')).toHaveText('n/d');
  });

  test('🔴 la GRANULARITE est dite, et elle se bascule a la main', async ({ page }) => {
    // Une granularite qui change toute seule fait que deux captures de la meme page cessent de se
    // comparer. La dire, et laisser la main, referme le defaut que ce choix ouvrait.
    await mock(page);
    await page.goto('/dashboard/quali');
    await expect(page.getByTestId('jours-granularite')).toContainText(/journée|day/);
    await page.getByTestId('jours-bascule').click();
    await expect(page.getByTestId('jours-granularite')).toContainText(/semaine|week/);
  });

  test('🔴 cliquer une journee RESTREINT la liste du dessous a cette journee', async ({ page }) => {
    // Le filtre passe par la PLAGE, pas par un filtre de plus : le serveur sait deja borner par dates, et
    // lui demander la meme chose d une seconde facon ferait deux chemins pour une question.
    const { plages } = await mock(page);
    await page.goto('/dashboard/quali');
    await expect(page.getByTestId('quali-ligne').first()).toBeVisible();
    plages.length = 0;
    await page.getByTestId('jour-ouvrir-2026-09-16').click();
    await expect(page.getByTestId('jour-choisi')).toBeVisible();
    await expect.poll(() => plages.some((u) => u.includes('from=2026-09-16') && u.includes('to=2026-09-16'))).toBe(true);
  });

  test('⚠️ et on peut REVENIR a toute la periode', async ({ page }) => {
    await mock(page);
    await page.goto('/dashboard/quali');
    await page.getByTestId('jour-ouvrir-2026-09-16').click();
    await expect(page.getByTestId('jour-choisi')).toBeVisible();
    await page.getByTestId('jour-retirer').click();
    await expect(page.getByTestId('jour-choisi')).toHaveCount(0);
  });

  test('aucune conversation analysee -> une phrase, pas un tableau vide', async ({ page }) => {
    await mock(page, { jours: [] });
    await page.goto('/dashboard/quali');
    await expect(page.getByTestId('jours-vide')).toBeVisible();
  });

  test('🔴 un corps MAL FORME ne tue pas la page : la liste du dessous reste affichee', async ({ page }) => {
    await mock(page, { jours: 'pas un tableau' });
    await page.goto('/dashboard/quali');
    await expect(page.getByTestId('jours-vide')).toBeVisible();
    await expect(page.getByTestId('quali-ligne').first()).toBeVisible();
  });

  test('un backend qui refuse -> un message, pas un tableau vide', async ({ page }) => {
    await mock(page, { statutJours: 503 });
    await page.goto('/dashboard/quali');
    await expect(page.getByTestId('jours-erreur')).toBeVisible();
  });
});

test.describe('Analyse des conversations : qui a repondu', () => {
  test('🔴 une conversation HYBRIDE porte PLUSIEURS badges', async ({ page }) => {
    // Le cas nomme par Julien : « parfois repondue par un agent humain puis par le MBA ». Rendre un seul
    // repondeur obligerait a en choisir un, donc a cacher l autre.
    await mock(page);
    await page.goto('/dashboard/quali');
    await expect(page.getByTestId('quali-badge-humain')).toBeVisible();
    await expect(page.getByTestId('quali-badge-mba')).toBeVisible();
  });

  test('🔴 `campagne` n est PAS un repondeur : il OUVRE l echange, il n y repond pas', async ({ page }) => {
    // Le compter ferait porter un badge « on vous a repondu » a toute conversation nee d une campagne, y
    // compris celles ou personne n a jamais repondu.
    await mock(page, { conversations: [CONV('cv1', ['campagne'])] });
    await page.goto('/dashboard/quali');
    await expect(page.getByTestId('quali-repondeurs').first()).toHaveText('n/d');
  });

  test('🔴 un scenario donne « Scripté », un agent IA donne « Agent IA »', async ({ page }) => {
    await mock(page, { conversations: [CONV('cv1', ['scenario', 'ia'])] });
    await page.goto('/dashboard/quali');
    await expect(page.getByTestId('quali-badge-scripte')).toBeVisible();
    await expect(page.getByTestId('quali-badge-agent')).toBeVisible();
  });

  test('⚠️ une API plus ANCIENNE, sans les origines, n affiche aucun badge plutot que d en inventer', async ({ page }) => {
    // 🔴 LE CAS EST REEL : la console part sur Vercel a chaque push, l API se deploie a la main sur le VPS.
    const sans: Record<string, unknown> = { ...CONV('cv1', []) };
    delete sans.origines;
    await mock(page, { conversations: [sans] });
    await page.goto('/dashboard/quali');
    await expect(page.getByTestId('quali-repondeurs').first()).toHaveText('n/d');
  });
});
