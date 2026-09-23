import { test, expect } from '@playwright/test';

/**
 * Onglet BASE DE CONNAISSANCE d'un agent IA.
 *
 * Ce qu'on vérifie vraiment ici : le client comprend que ces fiches sont la SEULE source de son agent (une
 * base vide fait un agent qui transfère tout, pas un agent bavard), il peut corriger une fiche sur place, et
 * le prix d'une relecture de source, c'est-à-dire le remplacement des fiches de cette adresse, lui est dit
 * AVANT le clic, pas découvert après.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const AG = '11111111-1111-4111-8111-111111111111';

const MANUELLE = {
  id: 'f1', titre: 'Les clés', corps: 'Remise des clés à l’accueil, de 8 h à 19 h.',
  source: { type: 'manuel' }, sourceUrl: null, derniereLectureAt: null, updatedAt: '2026-08-01T10:00:00.000Z',
};
const IMPORTEE = {
  id: 'f2', titre: 'La piscine', corps: 'Ouverte tous les jours de 9 h à 20 h.',
  source: { type: 'page', url: 'https://exemple.fr/residence' }, sourceUrl: 'https://exemple.fr/residence', derniereLectureAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
};
/** Lue il y a plus de trois mois, et jamais retouchée : c'est le cas que l'écran doit signaler. */
const PERIMEE = {
  id: 'f3', titre: 'Les tarifs', corps: 'La semaine à 620 euros en haute saison.',
  source: { type: 'page', url: 'https://exemple.fr/tarifs' }, sourceUrl: 'https://exemple.fr/tarifs', derniereLectureAt: '2025-01-15T10:00:00.000Z',
  updatedAt: '2025-01-15T10:00:00.000Z',
};
/** Lue il y a très longtemps, mais CORRIGÉE À LA MAIN hier : un humain vient de la relire. */
const RELUE = {
  id: 'f4', titre: 'Le ménage', corps: 'Forfait ménage à 60 euros.',
  source: { type: 'page', url: 'https://exemple.fr/menage' }, sourceUrl: 'https://exemple.fr/menage', derniereLectureAt: '2025-01-15T10:00:00.000Z',
  updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
};

/** Une fiche issue d'un DOCUMENT : indiscernable d'une fiche manuelle avant la provenance. */
const DOCUMENT = {
  id: 'f5', titre: 'Nos garanties', corps: 'La garantie décès verse un capital aux bénéficiaires.',
  source: { type: 'document', nom: 'Garanties.pdf' }, sourceUrl: null,
  derniereLectureAt: '2026-09-08T10:00:00.000Z', updatedAt: '2026-09-08T10:00:00.000Z',
};

const AGENT = {
  id: AG, label: 'Conseiller séjours', status: 'draft',
  mentionIa: 'Vous échangez avec un assistant automatique.', modele: 'modele-test',
  maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30000, inactiviteMinutes: 30,
  contactInconnu: 'lecture_seule',
  contenu: { nom: '', objectif: '', ton: '', personnalite: '', reglesTransfert: '', sorties: [] },
  ficheVersion: 4,
};

type Appel = { method: string; url: string; body: unknown };

async function mock(page: import('@playwright/test').Page, appels: Appel[], fiches: unknown[], importe?: { status: number; body: unknown }, apercuKo?: { status: number; body: unknown }, suggeree?: string) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    // 🔴 L'APERÇU, qui precede desormais toute ecriture : il rend ce que l'import RAMENERAIT.
    if (/\/knowledge\/supprimer$/.test(url)) {
      appels.push({ method, url, body: req.postDataJSON() });
      return json({ supprimees: (req.postDataJSON() as { ids: string[] }).ids.length, demandees: 2 });
    }
    if (/\/knowledge\/apercu$/.test(url)) {
      appels.push({ method, url, body: req.postDataJSON() });
      if (apercuKo) return json(apercuKo.body, apercuKo.status);
      return json({
        url: 'https://exemple.fr/residence', portee: 'page', plafondAtteint: false, ecartees: [],
        pages: [{ url: 'https://exemple.fr/residence', fiches: 3, caracteres: 1200 }],
      });
    }
    if (/\/knowledge\/import$/.test(url)) {
      appels.push({ method, url, body: req.postDataJSON() });
      const r = importe ?? { status: 200, body: { url: 'https://exemple.fr/residence', retirees: 2, ecrites: 3, plafond: 40 } };
      return json(r.body, r.status);
    }
    if (/\/knowledge(\/[^/?]+)?$/.test(url)) {
      if (method !== 'GET') appels.push({ method, url, body: req.postDataJSON() });
      if (method === 'DELETE') return route.fulfill({ status: 204, body: '' });
      if (method === 'GET') return json({ fiches });
      return json({ fiche: { ...MANUELLE, ...(req.postDataJSON() as object) } }, method === 'POST' ? 201 : 200);
    }
    // Ce que l'entretien a NOTÉ. Sans cette route, l'ecran se comporte comme avant, champ vide : les autres
    // tests de ce fichier passent donc inchanges, et c'est voulu.
    if (/\/setup\/suggestions$/.test(url)) return json({ connaissanceUrl: suggeree ?? null });
    if (new RegExp(`/agents/${AG}$`).test(url)) return json({ agent: AGENT });
    if (/\/agents(\?|$)/.test(url)) return json({ agents: [{ id: AG, label: 'Conseiller séjours', status: 'draft', sorties: [], modele: 'anthropic/claude-haiku-4.5' }] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Agents IA : la base de connaissance', () => {
  test('🔴 l écran DIT que sans fiche, l agent transfère tout', async ({ page }) => {
    // Le mécanisme anti-hallucination est un seuil dans notre code : sans source, le parcours sort par
    // « Aucune source ». Un client qui ne le sait pas cherchera l'erreur dans ses réglages de modèle.
    await mock(page, [], []);
    await page.goto(`/agents?id=${AG}&tab=connaissance`);
    await expect(page.getByTestId('kb-vide')).toBeVisible();
    await expect(page.getByText('il sort du bloc par « Aucune source »')).toBeVisible();
  });

  /**
   * 🔴 L'ADRESSE DONNÉE À L'ASSISTANT ARRIVE JUSQU'ICI (2026-09-18).
   *
   * L'entretien demandait « d'où viennent ses réponses de fond », insistait pour obtenir l'adresse EXACTE,
   * et cette réponse n'allait nulle part : cet écran restait vide et il fallait la recoller à la main.
   * Julien : « le bot m'a demandé l'adresse du site web mais je ne retrouve rien dans l'onglet base de
   * connaissance ». C'est le motif « offert-et-inerte » que ce produit s'interdit.
   */
  test('🔴 l adresse notée par l assistant PRÉ-REMPLIT le champ, et rien n est importé sans le client', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, [], undefined, undefined, 'https://ganprevoyance.fr');
    await page.goto(`/agents?id=${AG}&tab=connaissance`);

    await expect(page.getByTestId('kb-url')).toHaveValue('https://ganprevoyance.fr');
    await expect(page.getByTestId('kb-url-suggeree')).toContainText('noté cette adresse');
    /**
     * 🔴 RIEN N'EST PARTI TOUT SEUL, et c'est l'arbitrage de Julien : « Enregistrer » écrit des champs, il
     * n'aspire pas cinquante pages d'un site tiers. L'apercu, puis l'import, restent des gestes du client.
     */
    expect(appels.filter((a) => /apercu$|import$/.test(a.url))).toHaveLength(0);
  });

  test('⚠️ une adresse déjà saisie n est JAMAIS écrasée par la suggestion', async ({ page }) => {
    // La suggestion arrive d'un appel reseau, donc apres le premier rendu : si elle ecrasait la saisie, un
    // client qui tape vite verrait son adresse remplacee sous ses doigts.
    await mock(page, [], [], undefined, undefined, 'https://ganprevoyance.fr');
    await page.goto(`/agents?id=${AG}&tab=connaissance`);
    await page.getByTestId('kb-url').fill('https://autre-site.fr/page');
    await expect(page.getByTestId('kb-url')).toHaveValue('https://autre-site.fr/page');
  });

  test('ajoute une fiche à la main, la corrige, et la supprime', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, [MANUELLE]);
    await page.goto(`/agents?id=${AG}&tab=connaissance`);

    await page.getByTestId('kb-nouveau-titre').fill('Le linge');
    await page.getByTestId('kb-nouveau-corps').fill('Draps et serviettes fournis.');
    await page.getByTestId('kb-ajouter').click();
    await expect.poll(() => appels.some((a) => a.method === 'POST' && (a.body as { titre?: string })?.titre === 'Le linge'), { timeout: 5000 }).toBe(true);

    // 🔴 Le detail est REPLIE : a cinquante fiches venues d un site entier, une liste depliee est un mur
    // qu on ne relit jamais. On ouvre celle qu on veut corriger.
    await page.getByTestId('kb-ouvrir-f1').click();
    await page.getByTestId('kb-corps-f1').fill('Remise des clés à l’accueil, de 8 h à 21 h.');
    await page.getByTestId('kb-titre-f1').click(); // sortie du champ
    await expect.poll(
      () => appels.some((a) => a.method === 'PATCH' && String((a.body as { corps?: string })?.corps).includes('21 h')),
      { timeout: 5000 },
    ).toBe(true);

    await page.getByTestId('kb-supprimer-f1').click();
    await expect.poll(() => appels.some((a) => a.method === 'DELETE'), { timeout: 5000 }).toBe(true);
  });

  test('🔴 le prix d une relecture est DIT avant le clic, et le bilan après', async ({ page }) => {
    // Relire remplace : les corrections faites sur les fiches de cette adresse partent avec. Le découvrir
    // après coup, c'est perdre un travail d'édition sans avoir été prévenu.
    const appels: Appel[] = [];
    await mock(page, appels, [IMPORTEE]);
    await page.goto(`/agents?id=${AG}&tab=connaissance`);
    await expect(page.getByText('REMPLACE les fiches qu’elle avait déjà produites')).toBeVisible();

    await page.getByTestId('kb-url').fill('https://exemple.fr/residence');
    // 🔴 VOIR AVANT D'ECRIRE. Ce bouton ne lit plus la page pour l'ecrire : il montre ce qui serait
    // importe. Un import est difficile a defaire, et cinquante pages ecrites d'un coup sont cinquante jeux
    // de fiches a relire ou supprimer une par une si la portee etait mauvaise.
    await page.getByTestId('kb-importer').click();
    await expect(page.getByTestId('kb-apercu')).toBeVisible();
    // La propriete de l'apercu : RIEN n'a encore ete ecrit.
    expect(appels.some((a) => /import$/.test(a.url))).toBe(false);

    await page.getByTestId('kb-confirmer').click();
    await expect(page.getByTestId('kb-bilan')).toContainText('3 fiche(s) écrite(s), 2 remplacée(s)');
    expect(appels.find((a) => /import$/.test(a.url))?.body)
      .toEqual({ url: 'https://exemple.fr/residence', pages: ['https://exemple.fr/residence'] });
  });

  test('🔴 une source vieille de plus de trois mois est SIGNALÉE', async ({ page }) => {
    // La cause dominante des mauvaises réponses d'un agent est le contenu périmé, pas le modèle. C'est la
    // seule parade que l'écran peut offrir sans relire le site tout seul.
    await mock(page, [], [IMPORTEE, PERIMEE, RELUE]);
    await page.goto(`/agents?id=${AG}&tab=connaissance`);
    await expect(page.getByTestId('kb-perimee-f3')).toBeVisible();
    await expect(page.getByTestId('kb-perimee-f2')).toHaveCount(0);
    // 🔴 Et une fiche qu'un humain vient de corriger n'est PAS réclamée, même si sa source est vieille :
    // corriger une fiche EST une vérification. Sans ça l'avertissement crie sur tout et ne veut plus rien dire.
    await expect(page.getByTestId('kb-perimee-f4')).toHaveCount(0);
    // La date affichée reste celle de la LECTURE de la source, elle : c'est la provenance, pas la relecture.
    await expect(page.getByTestId('kb-lue-f4')).toContainText('2025');
    await expect(page.getByTestId('kb-lue-f2')).toContainText('20');
  });

  test('🔴 une page tronquée au plafond le DIT, elle ne se tait pas', async ({ page }) => {
    // Sans ce message, l'admin lit « 40 fiches écrites » et croit que toute sa page est devenue une source.
    // L'agent transférerait ensuite sur des questions que la page couvrait, sans explication possible.
    await mock(page, [], [], { status: 200, body: { url: 'https://exemple.fr/tout', retirees: 0, ecrites: 40, plafond: 40 } });
    await page.goto(`/agents?id=${AG}&tab=connaissance`);
    await page.getByTestId('kb-url').fill('https://exemple.fr/tout');
    await page.getByTestId('kb-importer').click();
    await page.getByTestId('kb-confirmer').click();
    await expect(page.getByTestId('kb-bilan')).toContainText('plafond de 40 fiches par page est atteint');
  });

  test('une erreur d APERÇU est ANNONCÉE, pas avalée', async ({ page }) => {
    // 🔴 C'est desormais le PREMIER endroit ou ca peut echouer : l'apercu va chercher la page. Une erreur
    // avalee ici laisserait l'ecran muet apres un clic, sans rien a corriger.
    await mock(page, [], [], undefined, { status: 422, body: { error: 'rien à importer : injoignable' } });
    await page.goto(`/agents?id=${AG}&tab=connaissance`);
    await page.getByTestId('kb-url').fill('https://exemple.invalide/p');
    await page.getByTestId('kb-importer').click();
    await expect(page.getByTestId('kb-erreur')).toContainText('injoignable');
    // Et aucun apercu ne s'affiche : on ne propose pas d'importer ce qu'on n'a pas pu lire.
    await expect(page.getByTestId('kb-apercu')).toHaveCount(0);
  });

  test('une erreur d IMPORT est ANNONCÉE, pas avalée', async ({ page }) => {
    // Le cas d'origine, conserve : l'apercu passe, et c'est l'ecriture qui echoue.
    await mock(page, [], [], { status: 422, body: { error: 'page injoignable : getaddrinfo ENOTFOUND' } });
    await page.goto(`/agents?id=${AG}&tab=connaissance`);
    await page.getByTestId('kb-url').fill('https://exemple.invalide/p');
    await page.getByTestId('kb-importer').click();
    await page.getByTestId('kb-confirmer').click();
    await expect(page.getByTestId('kb-erreur')).toContainText('injoignable');
  });

  test('🔴 le tableau DIT la provenance de chaque fiche', async ({ page }) => {
    // Julien, le 2026-09-08 : « il faut avoir en face de chaque fiche la provenance, est-ce parce qu on a
    // crawle le site ? ». Avant, une fiche issue d un PDF et une fiche tapee a la main etaient
    // indiscernables : les deux avaient sourceUrl a null.
    await mock(page, [], [MANUELLE, IMPORTEE, DOCUMENT]);
    await page.goto(`/agents?id=${AG}&tab=connaissance`);
    await expect(page.getByTestId('kb-provenance-f1')).toContainText('la main');
    await expect(page.getByTestId('kb-provenance-f2')).toContainText('exemple.fr/residence');
    await expect(page.getByTestId('kb-provenance-f5')).toContainText('Garanties.pdf');
  });

  test('🔴 on coche plusieurs fiches et on les supprime en UNE requete', async ({ page }) => {
    // Boucler cote navigateur ferait N allers-retours, dont certains echoueraient au milieu en laissant une
    // selection a moitie supprimee que personne ne sait plus reconstituer.
    const appels: Appel[] = [];
    await mock(page, appels, [MANUELLE, IMPORTEE, DOCUMENT]);
    await page.goto(`/agents?id=${AG}&tab=connaissance`);
    await page.getByTestId('kb-cocher-f1').check();
    await page.getByTestId('kb-cocher-f5').check();
    await page.getByTestId('kb-supprimer-selection').click();
    await expect.poll(() => appels.find((a) => /supprimer$/.test(a.url))?.body, { timeout: 5000 })
      .toEqual({ ids: ['f1', 'f5'] });
    // 🔴 UNE seule requete, pas deux : c est tout l interet.
    expect(appels.filter((a) => /supprimer$/.test(a.url))).toHaveLength(1);
  });

  test('🔴 l alerte « à relire » est VISIBLE sans ouvrir la fiche', async ({ page }) => {
    // Le passage au tableau l avait repliee derriere un clic : elle ne se serait plus jamais vue, alors que
    // le cadrage en fait la parade au defaut le plus courant du marche, le contenu perime. Un avertissement
    // qu il faut ouvrir pour voir n avertit personne.
    await mock(page, [], [PERIMEE]);
    await page.goto(`/agents?id=${AG}&tab=connaissance`);
    await expect(page.getByTestId('kb-perimee-f3')).toBeVisible();
    // Et le detail est bien REPLIE : c est la ligne qui porte l alerte.
    await expect(page.getByTestId('kb-corps-f3')).toHaveCount(0);
  });
});
