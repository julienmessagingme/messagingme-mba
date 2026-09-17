import { test, expect } from '@playwright/test';

/**
 * LA COLONNE DE DROITE DE LA SYNTHESE : les intentions, leurs sujets, et le chemin vers l ecran d analyse.
 *
 * 🔴 CE QUE CE FICHIER PROTEGE, ET QUI EST LE VRAI SUJET DE LA CARTE. Les six intentions sont une
 * enumeration FERMEE : elles n enflent pas. Le sujet, lui, est du texte LIBRE, et c est la que vit
 * l inflation que Julien redoutait (« on a un theme demande de devis, si un moment tu decides de creer un
 * theme demande de cotation, c est un peu con »). Mesure en production le 2026-09-17 : 13 sujets distincts
 * pour 14 analyses, dont QUATRE variantes de « consultation tarifs ». Ranges a plat ils sont disperses ;
 * sous leur intention, ils se retrouvent cote a cote et le probleme se voit tout seul.
 */
const ADMIN = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const RESUME = {
  enabled: true,
  retentionDays: 90,
  total: 14,
  sentiment: { positif: 5, neutre: 6, negatif: 3 },
  intent: { demande_devis: 0, sav: 0, reclamation: 0, information: 9, prise_rdv: 2, autre: 3 },
  resolution: { resolved: 9, unresolved: 5, rate: 9 / 14 },
  handledBy: { humain: 6, automatise: 8, mba: 0 },
  exchanges: { avg: 3.2, median: 3 },
  actions: { creer_devis: 0, rappeler: 2, relancer: 1, escalader: 0, aucune: 11 },
  topTopics: [{ topic: 'consultation tarifs', count: 2 }],
  // Les QUATRE variantes mesurees en production, rangees sous « Information » : c est exactement ce que la
  // carte doit rendre visible.
  topicsParIntention: {
    information: [
      { topic: 'consultation des tarifs', count: 2 },
      { topic: 'consultation tarifs', count: 1 },
      { topic: 'consultation tarifs et offres', count: 1 },
      { topic: 'consultation tarifs cinema', count: 1 },
    ],
    prise_rdv: [{ topic: 'prise de rendez-vous agence bordeaux', count: 2 }],
  },
  confidence: { lt50: 0, from50to70: 2, from70to90: 5, gte90: 7 },
};

async function mock(page: import('@playwright/test').Page, resume: unknown = RESUME) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), ADMIN);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    // ⚠️ Le NUAGE avant le RESUME : les deux adresses commencent par `/stats/conversations`, et l inverse
    // ferait servir le resume au nuage. C est le genre d ordre qui rend un test vert pour la mauvaise raison.
    if (url.includes('/stats/conversations/nuage')) return json({ points: [], moyenne: null, mesurees: 0, sansMesure: 0 });
    if (url.includes('/stats/conversations')) return json(resume);
    if (url.includes('/stats/cost/campaigns')) return json({ lignes: [], currency: 'EUR', hasRates: true, tronque: false });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: ADMIN.email, name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
}

test.describe('Performance Lab : les intentions et leurs sujets', () => {
  test('les six intentions sont la, dans un ordre FIXE', async ({ page }) => {
    // Un classement par volume ferait danser les barres d une periode a l autre, et l oeil prendrait ce
    // mouvement pour une information.
    await mock(page);
    await page.goto('/performance');
    await expect(page.getByTestId('carte-intentions')).toBeVisible();
    for (const i of ['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'autre']) {
      await expect(page.getByTestId(`intention-${i}`)).toBeVisible();
    }
  });

  test('🔴 deplier une intention montre ses SUJETS, et les variantes se retrouvent cote a cote', async ({ page }) => {
    // Le coeur de la demande : rendre l inflation visible plutot que de la raconter.
    await mock(page);
    await page.goto('/performance');
    await expect(page.getByTestId('intention-sujets-information')).toHaveCount(0);
    await page.getByTestId('intention-deplier-information').click();
    const sujets = page.getByTestId('intention-sujets-information');
    await expect(sujets).toContainText('consultation des tarifs');
    await expect(sujets).toContainText('consultation tarifs et offres');
    await expect(sujets).toContainText('consultation tarifs cinema');
  });

  test('⚠️ une intention SANS sujet n offre pas de chevron a cliquer', async ({ page }) => {
    // Un chevron qui ouvre le vide se lit comme une panne. `sav` est a zero dans la fixture.
    await mock(page);
    await page.goto('/performance');
    await expect(page.getByTestId('intention-deplier-sav')).toBeDisabled();
  });

  test('🔴 cliquer une intention emmene sur l analyse, FILTREE et sur la MEME periode', async ({ page }) => {
    // Par l ADRESSE et pas par un etat en memoire : l ecran devient partageable, et le retour arriere
    // ramene a la synthese. Retomber sur les 30 jours par defaut rendrait un compte different de celui
    // qu on vient de cliquer, et le chiffre de la synthese passerait pour faux.
    await mock(page);
    await page.goto('/performance');
    await page.getByTestId('intention-ouvrir-information').click();
    await expect(page).toHaveURL(/\/dashboard\/quali\?intention=information&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
  });

  test('🔴 arrive la, le filtre d intention est DEJA pose', async ({ page }) => {
    await mock(page);
    await page.goto('/dashboard/quali?intention=prise_rdv&from=2026-09-01&to=2026-09-17');
    await expect(page.getByTestId('quali-filtre-intent')).toHaveValue('prise_rdv');
  });

  test('⚠️ une intention BRICOLEE dans l adresse ne pose aucun filtre', async ({ page }) => {
    // Validee contre l enumeration : sinon le serveur refuserait le filtre en silence, et l ecran
    // afficherait « aucun resultat » sans que rien n explique pourquoi.
    await mock(page);
    await page.goto('/dashboard/quali?intention=nawak&from=2026-09-01&to=2026-09-17');
    await expect(page.getByTestId('quali-filtre-intent')).toHaveValue('');
  });

  test('⚠️ une API plus ANCIENNE, sans les sujets par intention, ne casse pas la carte', async ({ page }) => {
    // 🔴 LE CAS EST REEL : la console part sur Vercel a chaque push, l API se deploie a la main sur le VPS.
    // Entre les deux, `topicsParIntention` est absent de la reponse.
    const sansSujets: Record<string, unknown> = { ...RESUME };
    delete sansSujets.topicsParIntention;
    await mock(page, sansSujets);
    await page.goto('/performance');
    await expect(page.getByTestId('intention-information')).toBeVisible();
    await expect(page.getByTestId('intention-deplier-information')).toBeDisabled();
  });

  test('aucune conversation analysee -> une phrase, pas six barres a zero', async ({ page }) => {
    await mock(page, { ...RESUME, total: 0, intent: { demande_devis: 0, sav: 0, reclamation: 0, information: 0, prise_rdv: 0, autre: 0 }, topicsParIntention: {} });
    await page.goto('/performance');
    await expect(page.getByTestId('intentions-vide')).toBeVisible();
  });

  test('🔴 un corps MAL FORME ne tue pas la page : la colonne des couts reste affichee', async ({ page }) => {
    await mock(page, { pas: 'la bonne forme' });
    await page.goto('/performance');
    await expect(page.getByTestId('intentions-erreur')).toBeVisible();
    await expect(page.getByTestId('carte-couts')).toBeVisible();
  });
});
