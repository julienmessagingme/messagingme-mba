import { test, expect } from '@playwright/test';

/**
 * La page de synthèse du Performance Lab, et son nuage « satisfaction x urgence » (lot F du 2026-09-08).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE, et qui ne se lit pas dans le composant :
 *
 *  1. que le zéro se DESSINE. `satisfaction: 0` est une mesure (client très mécontent), pas une absence.
 *     Un `if (!p.satisfaction)` ou un `p.satisfaction || null` glissé n'importe où ferait disparaître
 *     exactement les points qui alarment, et l'écran resterait crédible sans eux ;
 *  2. que l'ordonnée MONTE. Une urgence de 10 doit se dessiner EN HAUT ; en SVG, `y` descend, donc
 *     l'inversion est à écrire à la main et se trompe sans rien casser de visible ;
 *  3. qu'un nuage vide se DISE. Les deux mesures sont neuves : le graphe démarrera vide en production, et
 *     un graphe vide sans un mot se lit comme un graphe cassé ;
 *  4. que les analyses SANS mesure soient comptées à part, jamais placées en (0,0).
 */
const ADMIN = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

type Nuage = {
  points: Array<{ satisfaction: number; urgence: number; n: number }>;
  moyenne: { satisfaction: number; urgence: number } | null;
  mesurees: number;
  sansMesure: number;
};

const NUAGE: Nuage = {
  // Volontairement CONTRASTÉ : un point dans le coin qui alarme (mécontent au maximum, pressé au maximum),
  // un point à l'opposé, et une case qui en empile plusieurs.
  points: [
    { satisfaction: 0, urgence: 10, n: 1 },
    { satisfaction: 9, urgence: 1, n: 3 },
  ],
  moyenne: { satisfaction: 6.75, urgence: 3.25 },
  mesurees: 4,
  sansMesure: 12,
};

async function mock(page: import('@playwright/test').Page, nuage: Nuage | 'erreur' = NUAGE) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), ADMIN);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/stats/conversations/nuage')) {
      if (nuage === 'erreur') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'nuage qualitatif non configure' }) });
      return json(nuage);
    }
    // ⚠️ La page porte DEUX cartes depuis le lot E : un faux qui ne sert que le nuage laisse l'autre carte
    // recevoir `{}`, et c'est exactement ce qui a fait tomber toute cette suite le 2026-09-08. Un double
    // doit ressembler au vrai serveur, sinon il teste un monde qui n'existe pas.
    if (url.includes('/stats/cost/campaigns')) return json({ lignes: [], currency: 'EUR', hasRates: true, tronque: false });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: ADMIN.email, name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
}

test.describe('Performance Lab : la page de synthèse', () => {
  test('🔴 le point à satisfaction ZÉRO est dessiné, et l’urgence 10 est EN HAUT', async ({ page }) => {
    await mock(page);
    await page.goto('/performance');

    const zero = page.getByTestId('nuage-point-0-10');
    const oppose = page.getByTestId('nuage-point-9-1');
    await expect(zero).toBeVisible();
    await expect(oppose).toBeVisible();

    // L'axe se vérifie par la GÉOMÉTRIE, pas par une classe : le point très urgent doit être plus haut à
    // l'écran (donc un `y` plus petit) et plus à gauche que le point satisfait et calme.
    const boiteZero = (await zero.boundingBox())!;
    const boiteOppose = (await oppose.boundingBox())!;
    expect(boiteZero.y).toBeLessThan(boiteOppose.y);
    expect(boiteZero.x).toBeLessThan(boiteOppose.x);

    // Une case qui empile trois conversations est plus grosse qu'une case seule.
    expect(boiteOppose.width).toBeGreaterThan(boiteZero.width);
  });

  test('la moyenne est dessinée, et le résumé la répète en toutes lettres', async ({ page }) => {
    await mock(page);
    await page.goto('/performance');
    await expect(page.getByTestId('nuage-moyenne')).toBeVisible();
    // La moyenne est formatée selon la langue (virgule en français) : c'est `fmtNote`, pas `toFixed`.
    await expect(page.getByTestId('nuage-resume')).toContainText('6,8');
  });

  /**
   * 🔴 CE TEST EXIGEAIT L'INVERSE JUSQU'AU 2026-09-17, ET LE RETOURNEMENT EST UNE DECISION DE JULIEN.
   *
   * Il vérifiait que le paragraphe « N analyses n'ont pas ces deux notes [...] elles ne valent pas zéro »
   * s'affiche. Julien l'a fait retirer (« tu peux enlever le blabla en dessous du tableau », puis « rien du
   * tout, on enlève » quand la question lui a été reposée avec la mesure). Le cas n'a donc PAS de
   * remplaçant : l'information n'est plus montrée, et c'est assumé.
   *
   * ⚠️ CE QUE CA COUTE, MESURE EN PRODUCTION LE JOUR MEME : 2 analyses sur 14 portent les deux notes. Le
   * nuage montre deux points sur quatorze conversations, et plus rien ne permet de s'en douter. Le risque
   * est temporaire (chaque nouvelle analyse porte les notes depuis la 0121) mais il est reel aujourd'hui.
   *
   * ⚠️ LE TEST GARDE MAINTENANT L'ABSENCE, plutot que de disparaitre : sans lui, quelqu'un remettrait le
   * paragraphe en croyant reparer un oubli, et la decision serait defaite sans que personne ne s'en
   * apercoive. `sansMesure` reste calcule et transporte : c'est l'affichage qu'on retire, pas la mesure.
   */
  test('🔴 le paragraphe des analyses SANS mesure n’est plus affiché (décision du 2026-09-17)', async ({ page }) => {
    await mock(page);
    await page.goto('/performance');
    await expect(page.getByTestId('nuage-resume')).toBeVisible();
    await expect(page.getByTestId('nuage-sans-mesure')).toHaveCount(0);
  });

  test('🔴 aucune conversation mesurée -> le graphe le DIT au lieu de rester vide', async ({ page }) => {
    // C'est l'état du premier jour en production : les deux mesures n'existent que depuis la migration
    // 0121 et l'historique n'est pas réanalysé.
    await mock(page, { points: [], moyenne: null, mesurees: 0, sansMesure: 14 });
    await page.goto('/performance');
    await expect(page.getByTestId('nuage-vide')).toBeVisible();
    await expect(page.getByTestId('nuage-moyenne')).toHaveCount(0);
    /**
     * ⚠️ CETTE LIGNE EXIGEAIT L'INVERSE JUSQU'AU 2026-09-17. Elle vérifiait que l'écran DIT quand même ce
     * qu'il ne montre pas (« 14 analyses existent, elles n'ont simplement pas de note »). Julien a fait
     * retirer ce paragraphe ; le cas n'a donc pas de remplaçant, et c'est assumé, avec son coût mesuré
     * (2 analyses sur 14 portent les notes en production). Ce qui reste garde est `nuage-vide`, qui
     * distingue toujours « aucune mesure » de « aucune conversation ».
     */
    await expect(page.getByTestId('nuage-sans-mesure')).toHaveCount(0);
  });

  test('un backend qui refuse -> un message d’erreur, pas un nuage vide', async ({ page }) => {
    // Un nuage vide affirmerait « aucune conversation mesurée ». Ici la vérité est « on ne sait pas ».
    await mock(page, 'erreur');
    await page.goto('/performance');
    await expect(page.getByTestId('nuage-erreur')).toBeVisible();
    await expect(page.getByTestId('nuage-vide')).toHaveCount(0);
  });

  test('la synthèse est dans l’onglet Performance Lab, et son entrée de menu y mène', async ({ page }) => {
    await mock(page);
    await page.goto('/dashboard');
    await page.getByRole('link', { name: /Synthèse|Summary/ }).click();
    await expect(page).toHaveURL(/\/performance$/);
    await expect(page.getByTestId('onglet-perf')).toHaveAttribute('aria-current', 'page');
  });
});
