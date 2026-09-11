import { test, expect } from '@playwright/test';

/**
 * Le funnel : barres VERTICALES, et plusieurs campagnes côte à côte.
 *
 * 🔴 CE QUE CES SPECS PROTÈGENT, ET POURQUOI ELLES LISENT LE DOM PLUTÔT QU'UNE CAPTURE. L'orientation d'une
 * barre est une décision produit (demandée par Julien), pas un détail de style : elle se vérifie donc, et
 * elle se vérifie sur ce qui la produit vraiment. Une capture d'écran dirait « ça ressemble à », un test qui
 * lit la hauteur calculée dit « c'est ».
 *
 * ⚠️ Le comparateur doit s'OUVRIR sur deux colonnes. Un comparateur qui démarre sur une seule ne se lit pas
 * comme un comparateur, et personne ne pense à en ajouter une seconde : le défaut d'affichage EST la
 * fonctionnalité.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CAMPAGNES = [
  { id: 'camp1', name: 'Promo été', status: 'completed', templateName: 'promo', templateLanguage: 'fr', workflowName: null, createdAt: '2026-08-20T10:00:00.000Z' },
  { id: 'camp2', name: 'Relance septembre', status: 'completed', templateName: 'relance', templateLanguage: 'fr', workflowName: null, createdAt: '2026-08-10T10:00:00.000Z' },
  { id: 'camp3', name: 'Vieux test', status: 'completed', templateName: 'vieux', templateLanguage: 'fr', workflowName: null, createdAt: '2026-07-01T10:00:00.000Z' },
];

/** Deux funnels aux formes DIFFÉRENTES : c'est ce qui rend la comparaison observable. */
const FUNNELS: Record<string, Record<string, unknown>> = {
  camp1: { sent: 100, delivered: 90, read: 60, replied: 12, failed: 2, buttonReplies: 0, urlClicks: null },
  camp2: { sent: 200, delivered: 100, read: 20, replied: 4, failed: 0, buttonReplies: 0, urlClicks: null },
  camp3: { sent: 50, delivered: 50, read: 50, replied: 50, failed: 0, buttonReplies: 0, urlClicks: null },
};

/**
 * Une campagne a SCENARIO : Meta ne rend AUCUN accuse, et les deux etapes du milieu sont INCONNUES.
 *
 * 🔴 CE N EST PAS UN CAS LIMITE, C EST LE CAS DOMINANT DE CE TYPE DE CAMPAGNE. Mesure en production le
 * 2026-09-11 : 29 envois de scenario, 29 sans accuse, soit 100 %. La branche scenario enregistre un
 * identifiant de message SYNTHETIQUE que l accuse de Meta ne peut pas apparier.
 */
const SANS_ACCUSE = { sent: 3, delivered: 0, read: 0, replied: 3, failed: 0, sansAccuse: 3, buttonReplies: 0, urlClicks: null };
/** La MEME campagne, mais un seul accuse manquant sur trois : la mesure existe, elle est juste partielle. */
const PARTIEL = { sent: 3, delivered: 2, read: 1, replied: 3, failed: 0, sansAccuse: 1, buttonReplies: 0, urlClicks: null };

async function monter(page: import('@playwright/test').Page) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/stats/campaign-funnel')) {
      // L'identifiant de campagne voyage dans le chemin : on rend LE funnel demandé, sinon les deux colonnes
      // afficheraient la même chose et la comparaison ne prouverait rien.
      const id = Object.keys(FUNNELS).find((k) => url.includes(k)) ?? 'camp1';
      return json(FUNNELS[id]);
    }
    if (url.includes('/campaigns')) return json({ campaigns: CAMPAGNES });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
  await page.goto('/dashboard/funnel');
  await expect(page.locator('#quanti-funnel')).toBeVisible();
}

test.describe('Funnel : barres verticales et comparaison', () => {
  test('🔴 U6 : les barres sont VERTICALES, et leur HAUTEUR porte la valeur', async ({ page }) => {
    await monter(page);
    const colonnes = page.getByTestId('funnel-colonnes').first();
    await expect(colonnes).toBeVisible();

    // Une barre verticale se distingue d'une horizontale par ce qui varie : ici la HAUTEUR change d'une
    // étape à l'autre, et la largeur non. Sur des barres horizontales, ce serait l'inverse.
    const barres = colonnes.locator('[data-testid^="funnel-barre-"]');
    const n = await barres.count();
    expect(n, 'le funnel doit avoir au moins quatre étapes').toBeGreaterThanOrEqual(4);

    const tailles = await barres.evaluateAll((els) => els.map((e) => {
      const r = e.getBoundingClientRect();
      return { h: Math.round(r.height), w: Math.round(r.width) };
    }));
    const hauteurs = tailles.map((s) => s.h);
    const largeurs = tailles.map((s) => s.w);
    // camp1 : 100 envoyés -> 90 -> 60 -> 12. Les hauteurs doivent DÉCROÎTRE, les largeurs rester égales.
    expect(new Set(hauteurs).size, 'les hauteurs doivent varier : sinon les barres ne portent pas la valeur').toBeGreaterThan(1);
    expect(new Set(largeurs).size, 'les largeurs doivent être égales : une largeur qui varie est une barre HORIZONTALE').toBe(1);
    for (let i = 1; i < hauteurs.length; i += 1) {
      expect(hauteurs[i]!, `étape ${i} plus haute que la précédente`).toBeLessThanOrEqual(hauteurs[i - 1]!);
    }
  });

  test('🔴 U5 : le comparateur s’ouvre sur DEUX campagnes, sans qu’on ait rien à faire', async ({ page }) => {
    await monter(page);
    // Un comparateur qui démarre sur une seule colonne ne se lit pas comme un comparateur.
    await expect(page.getByTestId('funnel-campagne-camp1')).toBeVisible();
    await expect(page.getByTestId('funnel-campagne-camp2')).toBeVisible();
    await expect(page.getByTestId('funnel-campagne-camp3')).toHaveCount(0);
  });

  test('🔴 U5 : les deux colonnes affichent des chiffres DIFFÉRENTS (la comparaison est réelle)', async ({ page }) => {
    await monter(page);
    // Sans ceci, deux funnels identiques passeraient : le test prouverait qu'il y a deux cadres, pas que
    // chacun montre SA campagne. C'est le piège du test qui passe pour une mauvaise raison.
    await expect(page.getByTestId('funnel-campagne-camp1')).toContainText('100');
    await expect(page.getByTestId('funnel-campagne-camp2')).toContainText('200');
  });

  test('une troisième campagne s’ajoute, et le comparateur en montre trois', async ({ page }) => {
    await monter(page);
    await page.getByTestId('funnel-campagnes').selectOption('camp3');
    await expect(page.getByTestId('funnel-campagne-camp3')).toBeVisible();
  });

  test('🔴 UN SEUL identifiant de zone PDF, même avec plusieurs funnels', async ({ page }) => {
    await monter(page);
    // Deux éléments partageant un `id` casseraient l'export (qui marque une zone par son id) ET l'inventaire
    // qui lit les zones dans le DOM. C'est le piège de la duplication d'un composant qui portait son id.
    await expect(page.locator('#quanti-funnel')).toHaveCount(1);
    await expect(page.getByTestId('pdf-quanti-funnel')).toHaveCount(1);
  });
});

test.describe('Le funnel ne confond plus « zero » et « on ne sait pas »', () => {
  /**
   * 🔴 SIGNALE PAR JULIEN LE 2026-09-11 : « 3 envoyes, 0 delivres, 0 lus et pourtant 3 repondus, erreur
   * manifeste non ? ». Chaque nombre etait juste ; c est leur mise cote a cote qui mentait. Une campagne a
   * SCENARIO n aura JAMAIS d accuse de livraison, par construction.
   */
  async function monterAvec(page: import('@playwright/test').Page, funnel: Record<string, unknown>) {
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/stats/campaign-funnel')) return json(funnel);
      if (url.includes('/campaigns')) return json({ campaigns: [CAMPAGNES[0]!] });
      if (url.includes('/unread-count')) return json({ count: 0 });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
      return json({});
    });
    await page.goto('/dashboard/funnel');
    await page.getByTestId('funnel-campagne-camp1').waitFor();
  }

  test('🔴 aucun accuse : « — » et la raison, jamais un zero', async ({ page }) => {
    await monterAvec(page, SANS_ACCUSE);
    const carte = page.getByTestId('funnel-campagne-camp1');
    // Les envoyes et les repondus restent des MESURES : eux se lisent.
    await expect(carte).toContainText('3');
    // Les deux etapes du milieu n en sont pas, et la carte le DIT plutot que d afficher 0.
    await expect(carte.getByTestId('funnel-sans-accuse')).toBeVisible();
    await expect(carte.getByText('—')).toHaveCount(2);
  });

  test('🔴 preuve inverse : un accuse PARTIEL garde ses chiffres', async ({ page }) => {
    // Sans ce cas, effacer la colonne des qu un accuse manque passerait le test ci-dessus, et on perdrait
    // une vraie mesure sur les envois qui, eux, ont bien ete accuses.
    await monterAvec(page, PARTIEL);
    const carte = page.getByTestId('funnel-campagne-camp1');
    await expect(carte.getByTestId('funnel-sans-accuse')).toHaveCount(0);
    await expect(carte.getByText('—')).toHaveCount(0);
  });
});
