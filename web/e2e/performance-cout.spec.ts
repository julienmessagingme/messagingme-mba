import { test, expect } from '@playwright/test';

/**
 * Le tableau « ce que coûte un engagement » de la page de synthèse (lot E du 2026-09-08).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : les TROIS cases qui doivent rester VIDES plutôt que d'afficher zéro. Un
 * zéro est une affirmation (« ça n'a rien coûté », « personne n'a cliqué ») ; l'absence dit « on ne peut
 * pas répondre », et c'est la vérité dans les trois cas. Le client décide de son budget sur cet écran :
 * un zéro de trop y coûte plus cher qu'une case vide.
 *
 * Le reste (le calcul lui-même) est tenu par `tests/cost.test.ts`, qui n'a besoin d'aucun navigateur.
 */
const ADMIN = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const COUT = {
  lignes: [
    // Une campagne complète : elle a un coût, des clics, donc un ratio.
    { campaignId: 'c-promo', nom: 'Promo été', template: 'promo', envoyes: 120, cout: 17.17, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, clics: 8, coutParClic: 2.1463 },
    // Une campagne à SCÉNARIO : pas de template, donc rien à mesurer côté clics.
    { campaignId: 'c-parcours', nom: 'Parcours bienvenue', template: null, envoyes: 40, cout: 5.72, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, clics: null, coutParClic: null },
    // Une campagne dont AUCUN envoi n'est chiffrable : la case coût est vide, et les envois sont comptés.
    { campaignId: 'c-inconnue', nom: 'Relance', template: 'relance', envoyes: 30, cout: null, nonChiffrables: 30, sansCategorie: 30, sansTarif: 0, clics: 0, coutParClic: null },
  ],
  currency: 'EUR',
  hasRates: true,
  tronque: false,
};

async function mock(page: import('@playwright/test').Page, cout: unknown = COUT) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), ADMIN);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/stats/cost/campaigns')) return json(cout);
    if (url.includes('/stats/conversations/nuage')) return json({ points: [], moyenne: null, mesurees: 0, sansMesure: 0 });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: ADMIN.email, name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
}

test.describe('Performance Lab : ce que coûte un engagement', () => {
  test('une campagne complète affiche son coût, ses clics et son ratio', async ({ page }) => {
    await mock(page);
    await page.goto('/performance');
    await expect(page.getByTestId('cout-montant-c-promo')).toContainText('17,17');
    await expect(page.getByTestId('cout-clics-c-promo')).toHaveText('8');
    // `fmtCost` : deux décimales au-dessus de 1, quatre en dessous (un tarif au message se lit en
    // millièmes). Le ratio est donc rendu « 2,15 € » ici, et « 0,0234 € » pour une campagne de masse.
    await expect(page.getByTestId('cout-ratio-c-promo')).toContainText('2,15');
  });

  test('🔴 une campagne à SCÉNARIO dit « sans lien tracé », elle n’affiche pas zéro clic', async ({ page }) => {
    // Un zéro se lirait « personne n'a cliqué » alors que la campagne n'envoie aucun template, donc aucun
    // lien tracé : il n'y a rien à mesurer. C'est la case que `todo.md` décrivait à l'envers.
    //
    // ⚠️ LE CAS EST LE MÊME, SEUL LE MOT CHANGE (2026-09-09). Il disait « non attribuable », que Julien a lu
    // comme une panne d'attribution : le test garde donc exactement ce qu'il exerçait, et vérifie EN PLUS
    // que le mot qui trompait a bien disparu de l'écran.
    await mock(page);
    await page.goto('/performance');
    await expect(page.getByTestId('cout-clics-c-parcours')).toContainText(/sans lien tracé|no tracked link/);
    await expect(page.getByTestId('cout-clics-c-parcours')).not.toContainText(/non attribuable|not attributable/);
    await expect(page.getByTestId('cout-clics-c-parcours')).not.toContainText('0');
    await expect(page.getByTestId('cout-ratio-c-parcours')).toHaveText('—');
  });

  test('🔴 un coût non chiffrable laisse la case VIDE et compte les envois à part', async ({ page }) => {
    await mock(page);
    await page.goto('/performance');
    await expect(page.getByTestId('cout-montant-c-inconnue')).toHaveText('—');
    // Les envois, eux, sont bien là : ils ont eu lieu, c'est leur PRIX qu'on ignore.
    await expect(page.getByTestId('cout-ligne-c-inconnue')).toContainText('30');
    await expect(page.getByTestId('cout-non-chiffrables')).toContainText('30');
    // 🔴 ET LA PHRASE DIT LAQUELLE DES DEUX CAUSES, sinon le lecteur ne sait pas s'il doit attendre ou aller
    // réparer. Ici la catégorie manque : c'est de l'historique, et la phrase doit le dater.
    await expect(page.getByTestId('cout-non-chiffrables')).toContainText(/catégorie enregistrée|recorded category/);
    await expect(page.getByTestId('cout-non-chiffrables')).toContainText(/7 septembre 2026|7 September 2026/);
  });

  test('🔴 zéro clic mesuré -> pas de ratio, jamais un ∞', async ({ page }) => {
    await mock(page);
    await page.goto('/performance');
    await expect(page.getByTestId('cout-clics-c-inconnue')).toHaveText('0');
    await expect(page.getByTestId('cout-ratio-c-inconnue')).toHaveText('—');
  });

  test('les deux réserves sur les clics sont AFFICHÉES, pas cachées dans une infobulle', async ({ page }) => {
    await mock(page);
    await page.goto('/performance');
    await expect(page.getByTestId('cout-reserves')).toContainText('2026-09-02');
    await expect(page.getByTestId('cout-reserves')).toContainText(/même adresse|same address/);
  });

  test('🔴 Meta ne rend aucun tarif -> l’écran le DIT au lieu d’afficher des zéros', async ({ page }) => {
    await mock(page, {
      lignes: [{ campaignId: 'c1', nom: 'Promo', template: 'promo', envoyes: 10, cout: null, nonChiffrables: 10, clics: 3, coutParClic: null }],
      currency: null,
      hasRates: false,
      tronque: false,
    });
    await page.goto('/performance');
    await expect(page.getByTestId('cout-sans-tarif')).toBeVisible();
    await expect(page.getByTestId('cout-montant-c1')).toHaveText('—');
  });

  test('aucune campagne sur la période -> une phrase, pas un tableau vide', async ({ page }) => {
    await mock(page, { lignes: [], currency: 'EUR', hasRates: true, tronque: false });
    await page.goto('/performance');
    await expect(page.getByTestId('cout-vide')).toBeVisible();
  });

  test('🔴 la période compte plus de campagnes que le tableau -> il le DIT', async ({ page }) => {
    // Une troncature muette se lit comme un inventaire complet : le client conclurait que la période n'a
    // rien d'autre, et le total du tableau paraîtrait contredire le graphe de coût de l'onglet voisin.
    await mock(page, { ...COUT, tronque: true });
    await page.goto('/performance');
    await expect(page.getByTestId('cout-tronque')).toBeVisible();
  });

  test('sans troncature, aucune phrase ne parle d’un reste', async ({ page }) => {
    // Preuve inverse : sans ce cas, une phrase affichée en permanence passerait le test ci-dessus.
    await mock(page);
    await page.goto('/performance');
    await expect(page.getByTestId('cout-tronque')).toHaveCount(0);
  });

  test('🔴 un corps MAL FORMÉ ne tue pas la page : la carte d’à côté reste affichée', async ({ page }) => {
    /**
     * Le type d'une réponse est une promesse, pas une preuve : une API plus ancienne que cette route, ou un
     * proxy qui répond `{}`, et `lignes.map` jette EN PLEIN RENDU. Ce n'est alors pas cette carte qui tombe,
     * c'est la PAGE, donc aussi le nuage qui n'a rien demandé. C'est arrivé pour de vrai le 2026-09-08 :
     * toute la suite de la synthèse est devenue muette le jour où cette carte est arrivée sur la même page.
     */
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), ADMIN);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/stats/cost/campaigns')) return json({});
      if (url.includes('/stats/conversations/nuage')) return json({ points: [{ satisfaction: 4, urgence: 6, n: 1 }], moyenne: { satisfaction: 4, urgence: 6 }, mesurees: 1, sansMesure: 0 });
      if (url.endsWith('/me')) return json({ email: ADMIN.email, name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/performance');
    await expect(page.getByTestId('cout-erreur')).toBeVisible();
    // 🔴 LA VRAIE ASSERTION : le voisin est toujours là.
    await expect(page.getByTestId('nuage-point-4-6')).toBeVisible();
  });

  test('un backend qui refuse -> un message d’erreur, pas un tableau vide', async ({ page }) => {
    // Un tableau vide affirmerait « aucune campagne n'a envoyé ». Ici la vérité est « on ne sait pas ».
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), ADMIN);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/stats/cost/campaigns')) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'cout par campagne non configure' }) });
      if (url.includes('/stats/conversations/nuage')) return json({ points: [], moyenne: null, mesurees: 0, sansMesure: 0 });
      if (url.endsWith('/me')) return json({ email: ADMIN.email, name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/performance');
    await expect(page.getByTestId('cout-erreur')).toBeVisible();
    await expect(page.getByTestId('cout-vide')).toHaveCount(0);
  });
});

/**
 * 🔴 LE CAS DE JULIEN, 2026-09-13 : sur « Testjulien2 », le destinataire n a PAS clique mais il a
 * REPONDU. Le tableau ne comptait que les clics, donc il annoncait « aucun engagement » sur une
 * campagne qui en avait produit un. Une reponse est un engagement de PREMIER niveau.
 */
test.describe('Performance Lab : une reponse compte comme un engagement', () => {
  const AVEC_ENGAGEMENT = {
    ...COUT,
    lignes: [
      // Zero clic, mais quatre personnes se sont engagees : c est la ligne qui etait vide avant.
      { campaignId: 'c-test', nom: 'Testjulien2', template: 'promo', envoyes: 100, cout: 5, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, clics: 0, coutParClic: null, engagements: 4, coutParEngagement: 1.25 },
    ],
  };

  test('🔴 zero clic mais des engages : la colonne engagement est REMPLIE', async ({ page }) => {
    await mock(page, AVEC_ENGAGEMENT);
    await page.goto('/performance');
    await expect(page.getByTestId('cout-engages-c-test')).toHaveText('4');
    await expect(page.getByTestId('cout-ratio-engage-c-test')).not.toHaveText('—');
    // 🔴 ET LA COLONNE CLIC RESTE VIDE, ce qui est la verite : personne n a clique. Les deux colonnes
    // disent deux choses differentes, et c est pour ca qu on a AJOUTE la seconde sans renommer la premiere.
    await expect(page.getByTestId('cout-ratio-c-test')).toHaveText('—');
  });

  /**
   * ⚠️ UNE API PLUS ANCIENNE NE REND PAS CES CHAMPS, et ce cas arrive VRAIMENT : la console part sur
   * Vercel a chaque push, l API se deploie a la main sur le VPS. Entre les deux, l ecran doit tenir.
   */
  test('une reponse SANS les champs d engagement ne casse pas l ecran', async ({ page }) => {
    await mock(page); // COUT, qui ne porte ni engagements ni coutParEngagement
    await page.goto('/performance');
    await expect(page.getByTestId('cout-engages-c-promo')).toHaveText('—');
    // Le reste de la ligne reste lisible : c est ca, « ne pas casser ».
    await expect(page.getByTestId('cout-clics-c-promo')).toHaveText('8');
  });
});
