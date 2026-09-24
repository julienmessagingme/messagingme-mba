import { test, expect } from '@playwright/test';

/**
 * L'en-tête identitaire de la fiche d'un agent IA, le menu passé en colonne, et le logo du modèle en liste.
 *
 * 🔴 CE QUE SEUL UN TEST DE BOUT EN BOUT VOIT ICI. Le composant `EnteteAgent` est tenu par
 * `tests/web-entete-agent-parite.test.ts`, la dérivation du logo par `tests/web-logos-llm.test.ts`. Ce qui
 * reste, et qui ne se voit qu'à l'écran : que cette page-là le remplisse bien (le bon modèle, le bon statut,
 * les manques devenus des étapes cliquables), qu'elle n'affirme RIEN qu'elle n'ait mesuré, que le menu ne se
 * rende qu'une fois à toutes les largeurs, et que le logo de la liste ne change pas le nom accessible du
 * bouton d'ouverture, ce qui casserait `agents-modele.spec.ts` en entier.
 *
 * ⚠️ IL N'EXISTE AUCUN HELPER PARTAGÉ POUR LES AGENTS : `web/e2e/support/` ne porte que l'accueil, le MBA et
 * les zones PDF, et chaque suite d'agents définit son propre faux backend en tête de fichier. Celui-ci est
 * repris de `agents-fiche.spec.ts`, avec un paramètre de plus pour la route de comptage.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const FICHE_VIDE = { nom: '', objectif: '', ton: '', personnalite: '', reglesTransfert: '', sorties: [] };
/** ⚠️ `modele-test` N'A PAS DE BARRE OBLIQUE, donc pas de fournisseur : `logoDuModele` rend `null` et c'est la
 *  PASTILLE qui s'affiche. C'est le comportement réel d'un agent au modèle hors catalogue, et un cas le garde
 *  plus bas ; les cas qui veulent un vrai logo posent un modèle réel dans leur fixture. */
const AGENT = {
  id: 'ag1', label: 'Conseiller séjours', status: 'draft',
  mentionIa: 'Vous échangez avec un assistant automatique.', modele: 'modele-test',
  maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30000, inactiviteMinutes: 30,
  contactInconnu: 'lecture_seule', contenu: FICHE_VIDE, ficheVersion: 4,
};

const LISTE_PAR_DEFAUT = [{ id: 'ag1', label: 'Conseiller séjours', status: 'draft', sorties: [], modele: 'anthropic/claude-haiku-4.5' }];

type Opts = {
  /** Le modèle porté par la FICHE ouverte (celui dont l'en-tête montre le logo). */
  modele?: string;
  /** La liste des agents, dont le modèle décide du logo de chaque ligne. */
  liste?: unknown[];
  /** Ce que rend la route des manques. `undefined` = la route répond, sans rien à signaler. */
  manques?: unknown[];
  /** Ce que rend la route de comptage. `undefined` = elle n'est pas montée (corps vide, donc « on ne sait pas »). */
  messages?: number | null;
  /** `true` : la route de comptage rend 403, comme pour un compte non administrateur. */
  comptageRefuse?: boolean;
};

async function mockAgents(page: import('@playwright/test').Page, opts: Opts = {}) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  const courant = { ...AGENT, modele: opts.modele ?? AGENT.modele };
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    // AVANT `/agents/ag1` : le suffixe est un segment de plus, il ne doit pas être pris pour la fiche.
    if (/\/agents\/ag1\/messages$/.test(url)) {
      if (opts.comptageRefuse === true) return json({ error: 'interdit' }, 403);
      return json(opts.messages === undefined ? {} : { messages: opts.messages, jours: 30 });
    }
    if (/\/manques$/.test(url)) return json({ manques: opts.manques ?? [], avertissements: [] });
    if (/\/agents\/ag1$/.test(url)) return json({ agent: courant });
    if (/\/agents(\?|$)/.test(url)) return json({ agents: opts.liste ?? LISTE_PAR_DEFAUT });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Agents IA : l en-tête et le menu en colonne', () => {
  test('l en-tete porte le logo du modele, le nom, le statut, les etapes et le chiffre', async ({ page }) => {
    await mockAgents(page, {
      modele: 'anthropic/claude-haiku-4.5',
      messages: 1412,
      manques: [{ onglet: 'connaissance', message: 'La base de connaissance est vide : l’agent transférerait toutes les questions de fond.' }],
    });
    await page.goto('/agents?id=ag1&tab=identite');

    await expect(page.getByTestId('entete-agent')).toBeVisible();
    // 🔴 UN `<h2>` : `agents-fiche.spec.ts` ouvre la fiche par ce rôle de titre. Le dégrader en paragraphe
    // ferait échouer une suite que ce lot ne touche pas.
    await expect(page.getByRole('heading', { name: 'Conseiller séjours' })).toBeVisible();
    await expect(page.getByTestId('entete-agent-logo')).toBeVisible();
    // Le modèle sous le nom : c'est la précision de CET écran, là où l'agent de Meta y met son numéro.
    await expect(page.getByTestId('entete-agent-precision')).toContainText('anthropic/claude-haiku-4.5');
    /**
     * 🔴 ET IL SE TRONQUE, ce qu'aucune assertion ne gardait. Le 2026-09-24, `precision` est passé d'un
     * `<p class="truncate">` à un `<div class="flex">` pour loger la pastille du numéro sur l'AUTRE écran :
     * cette fiche-ci a perdu sa troncature sans qu'un seul test bouge, et un identifiant de modèle ne se
     * coupe pas tout seul, donc il poussait la mise en page.
     *
     * ⚠️ `toContainText` NE LE VOIT PAS : le texte est là dans les deux cas, et un texte non tronqué revient
     * à la ligne au lieu de déborder de la page. Ce qui distingue les deux états est la RÈGLE appliquée, donc
     * c'est elle qu'on lit, et LES TROIS : `truncate` pose `overflow: hidden`, `text-overflow: ellipsis` ET
     * `white-space: nowrap`.
     *
     * 🔴 LA TROISIÈME MANQUAIT, ET C'ÉTAIT PRÉCISÉMENT CELLE QUI TIENT LE MODE DE DÉFAILLANCE DÉCRIT
     * CI-DESSUS : retirer `whitespace-nowrap` seul laissait cette assertion verte et rendait le retour à la
     * ligne. Une garde qui lit deux des trois règles d'un utilitaire en garde deux tiers.
     * ⚠️ ET « NI UN CONTRÔLE DE DÉBORDEMENT » ÉTAIT TROP FORT : `scrollWidth > clientWidth` sur ce span
     * distingue bien les deux états. Lire les règles nomme la CAUSE, le débordement n'en montre que l'EFFET,
     * mais les deux voient le défaut. Une justification qui exclut l'autre approche fait renoncer à un filet.
     */
    const precision = page.getByTestId('entete-agent-precision').locator('span').first();
    expect(await precision.evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis');
    expect(await precision.evaluate((el) => getComputedStyle(el).overflow)).toBe('hidden');
    expect(await precision.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('nowrap');

    // L'état d'activation a DÉMÉNAGÉ dans l'en-tête, et il n'y est qu'une fois (la fiche n'affiche pas la
    // liste) : deux copies jetteraient `agents-fiche.spec.ts` en violation de mode strict.
    await expect(page.getByTestId('entete-agent')).toContainText('Brouillon');
    await expect(page.getByTestId('agent-activer')).toHaveCount(1);
    await expect(page.getByTestId('agent-statut-draft')).toHaveCount(1);

    // Le chiffre, et surtout ce qu'il mesure, écrit à côté de lui.
    await expect(page.getByTestId('entete-agent-messages')).toContainText('1 412');
    // 🔴 LES DEUX MOITIÉS DE L'AVEU, assertées séparément. La première a été ajoutée par la revue finale du
    // 2026-09-23 : « messages échangés » EXCLUT les modèles sortants sur l'Accueil et au Performance Lab, et
    // les INCLUT ici. Sans ce mot, le même terme désigne deux périmètres dans la même console.
    await expect(page.getByTestId('entete-agent-messages')).toContainText('les envois de campagne');
    await expect(page.getByTestId('entete-agent-messages'))
      .toContainText('ce que votre équipe a écrit après une reprise');
    // 🔴 AUCUN RATIO ICI, contrairement à l'agent de Meta : le dénominateur n'existe pas côté agent IA (le
    // nombre de contrôles qui s'appliquent varie d'un agent à l'autre), et en inventer un afficherait un
    // « n sur m » faux la moitié du temps.
    await expect(page.getByTestId('entete-agent-ratio')).toHaveCount(0);

    // L'étape mène à l'onglet où elle se règle : une liste de manques sans le geste se lit comme un reproche.
    await expect(page.getByTestId('entete-agent-etapes')).toContainText('1 étape à finir');
    await page.getByTestId('entete-etape-connaissance').click();
    await expect(page).toHaveURL(/tab=connaissance/);

    // 🔴 LE CAS QUI PROTÈGE LES QUATRE AUTRES SUITES D'AGENTS : un seul élément par testid d'onglet, à toutes
    // les largeurs. Deux listes rendues feraient tomber tous leurs `.click()` en mode strict.
    await expect(page.getByTestId('mba-tab-identite')).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.getByTestId('mba-tab-identite')).toHaveCount(1);

    // 🔴 C'EST LA BARRE D'ONGLETS QUI DÉFILE, PAS LA PAGE. Un élément de grille a `min-width: auto` : sans
    // `min-w-0` sur la colonne du MENU, la grille prend la largeur des neuf onglets et c'est la page ENTIÈRE
    // qui part de travers sur un téléphone. Mesuré sur l'écran jumeau avant correctif : 1029 px pour 390.
    const debordement = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(debordement, 'la page déborde horizontalement').toBe(0);
  });

  test('⚠️ un modele hors catalogue rend la PASTILLE, pas un logo cassé', async ({ page }) => {
    // C'est le cas d'un agent réglé avant le catalogue, ou par l'API : son identifiant n'a pas de préfixe
    // connu. Un `<img>` sur une adresse inexistante afficherait une icône cassée à la place de l'identité.
    await mockAgents(page); // AGENT.modele vaut 'modele-test', sans préfixe
    await page.goto('/agents?id=ag1&tab=identite');
    await expect(page.getByTestId('entete-agent-pastille')).toBeVisible();
    await expect(page.getByTestId('entete-agent-logo')).toHaveCount(0);
  });

  test('🔴 sans la route de comptage, AUCUN chiffre, et la fiche marche', async ({ page }) => {
    // La fenêtre où Vercel a publié l'écran et où l'API n'est pas encore déployée. Un 0 se lirait « cet agent
    // n'a parlé à personne », ce qui est une information FAUSSE présentée comme une mesure.
    await mockAgents(page, { comptageRefuse: true });
    await page.goto('/agents?id=ag1&tab=identite');
    await expect(page.getByTestId('entete-agent')).toBeVisible();
    await expect(page.getByTestId('entete-agent-messages')).toHaveCount(0);
    // La fiche n'est pas tombée en erreur : l'en-tête, les onglets et le panneau sont là.
    await expect(page.getByTestId('agent-erreur')).toHaveCount(0);
    await expect(page.getByTestId('mba-tab-tester')).toBeVisible();
  });

  test('🔴 manques NON LUS : aucune etape, et surtout pas « Tout est réglé »', async ({ page }) => {
    // Le défaut trouvé sur l'écran jumeau : une liste d'étapes VIDE se lit « tout est réglé ». Un serveur plus
    // ancien que la route des manques rend 404, et cette fiche doit alors se taire, pas décerner un quitus.
    await mockAgents(page, { manques: [] });
    await page.route('**/api/backend/**/manques', (r) => r.fulfill({ status: 404, body: '{}' }));
    await page.goto('/agents?id=ag1&tab=identite');
    await expect(page.getByTestId('entete-agent')).toBeVisible();
    await expect(page.getByTestId('entete-agent-etapes')).toHaveCount(0);
  });

  test('🔴 le logo de la liste ne change PAS le nom accessible du bouton', async ({ page }) => {
    // LE PIÈGE EXACT QUI CASSERAIT `agents-modele.spec.ts` EN ENTIER : son clic d'ouverture vit dans un
    // helper commun à ses quatre tests, et il cible `getByRole('button', { name: /Conseiller séjours/ })`.
    // Le nom accessible d'un bouton inclut le texte alternatif de ses images, d'où l'`alt` vide.
    await mockAgents(page);
    await page.goto('/agents');
    const ligne = page.getByTestId('agent-ligne-ag1');
    await expect(ligne).toBeVisible();
    await expect(ligne).toHaveAccessibleName('Conseiller séjours Brouillon');
    await expect(page.getByRole('button', { name: /Conseiller séjours/ }).first()).toBeVisible();
    // Et la ligne continue de mener à la fiche.
    await ligne.click();
    await expect(page.getByTestId('entete-agent')).toBeVisible();
  });

  test('🔴 une liste SANS `modele` ne fait pas tomber l ecran', async ({ page }) => {
    // LA FENÊTRE RÉELLE : Vercel publie la console au `git push`, l'API attend son `up`, et `modele` est
    // NEUF dans la projection du serveur. Une ligne sans lui vaut `undefined`, or `logoDuModele` appelle
    // `.indexOf` dessus : sans le repli posé dans `listAgents`, c'est la LISTE ENTIÈRE qui tombe, pas
    // seulement son icône. Ce cas est la seule chose qui distingue les deux.
    await mockAgents(page, { liste: [{ id: 'ag1', label: 'Conseiller séjours', status: 'draft', sorties: [] }] });
    await page.goto('/agents');
    await expect(page.getByTestId('agent-ligne-ag1')).toBeVisible();
    await expect(page.getByTestId('agent-ligne-ag1')).toHaveAccessibleName('Conseiller séjours Brouillon');
    await expect(page.getByTestId('agent-ligne-ag1').locator('img')).toHaveCount(0);
  });

  test('la ligne de liste porte le logo du fournisseur, ou sa pastille', async ({ page }) => {
    await mockAgents(page, {
      liste: [
        { id: 'ag1', label: 'Conseiller séjours', status: 'draft', sorties: [], modele: 'anthropic/claude-haiku-4.5' },
        { id: 'ag2', label: 'Agent sans marque', status: 'active', sorties: [], modele: 'modele-test' },
      ],
    });
    await page.goto('/agents');
    await expect(page.getByTestId('agent-ligne-ag1').locator('img')).toHaveAttribute('src', '/llm/anthropic.png');
    // Le repli est un DESSIN, pas un mot : masqué aux lecteurs d'écran, donc absent du nom du bouton.
    await expect(page.getByTestId('agent-ligne-ag2').locator('img')).toHaveCount(0);
    await expect(page.getByTestId('agent-ligne-ag2')).toHaveAccessibleName('Agent sans marque Actif');
  });
});
