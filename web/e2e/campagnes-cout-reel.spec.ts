import { test, expect } from '@playwright/test';

/**
 * LE COUT DE L'ONGLET CAMPAGNES VIENT DU SERVEUR, IL NE S'INVENTE PLUS.
 *
 * 🔴 LE DEFAUT QUE CE SPEC REPRODUIT PUIS INTERDIT (releve par Julien le 2026-09-23 sur ses propres
 * campagnes). L'ecran multipliait les DESTINATAIRES par le tarif Meta de la CATEGORIE de la campagne, sans
 * regarder le canal ni ce qui etait parti. Mesure en production : 5 campagnes sur 7 affichaient un prix
 * faux. Quatre campagnes a scenario n'avaient envoye AUCUN modele facturable et affichaient 0,0712 €
 * chacune ; une campagne RCS affichait le tarif d'un modele Meta, alors que le RCS a ses propres prix
 * (6 cts, 8 cts en conversationnel, saisis par espace depuis la migration 0154).
 *
 * 🔴 ET LE CHIFFRE VIENT DE LA MEME ROUTE QUE PERFORMANCE LAB. C'est ce que ces tests protegent vraiment :
 * pas la presence d'un nombre, mais le fait que les deux ecrans ne puissent plus se contredire. Un calcul
 * local « equivalent » diverge le jour ou l'un des deux change, et personne ne le voit.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const counts = { total: 1, pending: 0, sending: 0, sent: 1, failed: 0, skipped: 0 };
const campagne = (id: string, name: string, templateName: string | null) => ({
  id, name, category: 'marketing', status: 'completed', phoneNumberId: 'pn1',
  templateName, templateLanguage: templateName ? 'fr' : null, workflowName: templateName ? null : 'Parcours',
  createdAt: '2026-09-14T09:00:00.000Z', scheduledAt: null, archivedAt: null, counts,
});

const CAMPAIGNS = [
  campagne('c-tpl', 'Testjulien2', 'bordeo'),
  campagne('c-rcs', 'gr sentis', null),
  campagne('c-wf', 'test4', null),
];

/** Ce que rend la route du cout : un modele chiffre, un RCS conversationnel a 8 cts, un scenario inconnu. */
const COUT = {
  lignes: [
    { campaignId: 'c-tpl', nom: 'Testjulien2', template: 'bordeo', envoyes: 1, envois: 1, cout: 0.0712, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, clics: null, coutParClic: null },
    { campaignId: 'c-rcs', nom: 'gr sentis', template: null, envoyes: 0, envois: 1, cout: 0.08, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, clics: null, coutParClic: null },
    { campaignId: 'c-wf', nom: 'test4', template: null, envoyes: 0, envois: 1, cout: null, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, clics: null, coutParClic: null },
  ],
  tronque: false, currency: 'EUR', hasRates: true,
};

const brancher = async (page: import('@playwright/test').Page, cout: unknown = COUT) => {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/stats/cost/campaigns')) {
      if (cout === null) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"indisponible"}' });
      return json(cout);
    }
    if (url.includes('/stats/templates')) return json({ breakdown: [], pricing: { byCategory: { marketing: { volume: 1, ratePerMessage: 0.0712 } }, totalCost: 0.0712, currency: 'EUR' } });
    if (url.includes('/campaigns/c-')) return json({ ...CAMPAIGNS[2], paramMapping: [], recipients: [], chaine: [] });
    if (url.includes('/campaigns')) return json({ campaigns: CAMPAIGNS });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.endsWith('/workflows')) return json({ workflows: [] });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/campaigns');
};

test.describe('Campagnes : le coût est celui du serveur', () => {
  test('🔴 une campagne RCS porte SON prix, pas un tarif de modèle Meta', async ({ page }) => {
    await brancher(page);
    // 8 cts : le tarif RCS conversationnel. Le tarif de modèle (0,0712 €) serait le défaut d'avant.
    await expect(page.getByTestId('campagne-cout-c-rcs')).toHaveText(/0,08/);
    await expect(page.getByTestId('campagne-cout-c-rcs')).not.toHaveText(/0,07/);
  });

  test('🔴 une campagne à SCÉNARIO sans rien de facturable n’affiche AUCUN tarif', async ({ page }) => {
    await brancher(page);
    await expect(page.getByTestId('campagne-cout-c-wf')).toHaveText(/indisponible|unavailable/i);
  });

  test('une campagne à modèle direct garde son prix', async ({ page }) => {
    await brancher(page);
    await expect(page.getByTestId('campagne-cout-c-tpl')).toHaveText(/0,07/);
  });

  test('🔴 le total DIT combien de campagnes il ne sait pas chiffrer', async ({ page }) => {
    // Une campagne au coût inconnu vaut zéro dans la somme, ce qui est la seule addition possible. La taire
    // ferait lire le total comme complet.
    await brancher(page);
    await expect(page.getByTestId('campagnes-cout-total')).toHaveText(/0,15/); // 0,0712 + 0,08 arrondi
    await expect(page.getByTestId('campagnes-cout-partiel')).toHaveText(/1 /);
  });

  test('🔴 route du coût indisponible -> aucun prix affiché, et surtout aucun prix inventé', async ({ page }) => {
    // Le front part sur Vercel au push et l'API sur le VPS plus tard : pendant cette fenêtre, l'écran doit
    // se taire plutôt que de retomber sur son ancien calcul.
    await brancher(page, null);
    await expect(page.getByText(/coût estimé indisponible|estimated cost unavailable/i)).toBeVisible();
    await expect(page.getByTestId('campagne-cout-c-rcs')).toHaveText(/indisponible|unavailable/i);
  });
});
