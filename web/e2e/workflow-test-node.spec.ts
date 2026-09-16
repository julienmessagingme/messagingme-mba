import { test, expect } from '@playwright/test';

/**
 * E2E « tester À PARTIR D'UN BLOC » (2026-09-16) : chaque bloc du constructeur porte un bouton lecture en
 * haut à gauche, qui ouvre le panneau de test avec un lien pointant CE bloc.
 *
 * 🔴 CE QU'AUCUN TEST UNITAIRE NE VOIT, et qui est tout l'intérêt de ce fichier :
 *  - le suffixe arrive VRAIMENT dans le lien affiché (le serveur le lira par égalité, sans normalisation) ;
 *  - le clic n'ouvre PAS le panneau de configuration du bloc par-dessus (c'est le `stopPropagation`) ;
 *  - le panneau DIT que le test démarre à ce bloc, au lieu de promettre le début du scénario.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
// Jeton FICTIF (aucun secret) : valeur figée pour rendre les assertions lisibles.
const MOT_TEST = 'test-a7k2m9p3';
const LIEN = `https://wa.me/33525680250?text=${MOT_TEST}`;

/**
 * 🔴 DE VRAIS IDENTIFIANTS, c'est-à-dire des UUID, et ce n'est PAS cosmétique. Le constructeur les produit
 * avec `crypto.randomUUID()` (mesuré : les 64 blocs de production en portent un), ils traversent un
 * paramètre d'URL, puis `normalizeTestToken` côté serveur. Avec des identifiants courts comme « n1 », ce
 * fichier ne prouvait RIEN de la forme réelle : ni que `searchParams.set` laisse les tirets intacts, ni que
 * le texte obtenu passe le filtre du chemin chaud. C'est le seul endroit où les deux moitiés se rencontrent.
 */
const N1 = '0f7c9a21-4d3e-4b18-9a55-1c2e3f4a5b6c';
const N2 = '7b2d4e60-91af-4c73-8e15-6d0a9f3b2c48';

/** Scénario à DEUX blocs : sans le second, on ne pourrait pas distinguer « ce bloc » de « le début ». */
const GRAPHE = {
  nodes: [
    { id: N1, type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } },
    { id: N2, type: 'quick_message', position: { x: 0, y: 160 }, data: { body: 'Et ensuite ?' } },
  ],
  edges: [{ id: 'e1', source: N1, target: N2 }],
};

/**
 * LE FILTRE DU SERVEUR, RECOPIÉ ICI EXPRÈS, et c'est la seule copie assumée de ce lot.
 *
 * Aucun fichier de `web/` n'a le droit d'importer `src/` : la vérification de bout en bout ne peut donc pas
 * appeler `lireJetonDeTest`. Plutôt que de faire confiance, on rejoue sa forme sur le texte RÉELLEMENT
 * produit par le navigateur. Si les deux divergent un jour, c'est ICI que ça se verra, au lieu de se voir
 * sur le téléphone de quelqu'un.
 */
const FILTRE_SERVEUR = /^test-[0-9a-hjkmnp-tv-z]{8}(\.[0-9a-z_-]{1,64})?$/;

async function ouvrirBuilder(page: import('@playwright/test').Page) {
  /** L'ORDRE des appels au serveur : c'est lui, et lui seul, qui prouve que le brouillon part AVANT le test. */
  const appels: string[] = [];
  const wf = { id: 'wf1', name: 'Scénario E2E', graph: GRAPHE, createdAt: '', updatedAt: '' };
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/workflows\/wf1\/test-link$/.test(url) && req.method() === 'POST') {
      appels.push('test-link');
      return json({ token: MOT_TEST, phone: '+33 5 25 68 02 50', link: LIEN });
    }
    if (req.method() === 'PATCH' && /\/workflows\/wf1$/.test(url)) {
      const body = (req.postDataJSON() ?? {}) as { graph?: { nodes?: Array<{ data?: { body?: string } }> } };
      const corps = body.graph?.nodes?.map((nd) => nd.data?.body ?? '').join('|') ?? '';
      appels.push(`patch:${corps}`);
      return json({ ok: true, brouillon: true });
    }
    if (/\/workflows\/wf1$/.test(url)) return json({ workflow: wf });
    if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Scénario E2E', graph: GRAPHE }] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/workflows?open=wf1');
  return { appels };
}

test.describe('Constructeur : tester à partir d’un bloc', () => {
  test('🔴 le bouton d’un bloc ouvre le panneau de test avec le lien de CE bloc', async ({ page }) => {
    await ouvrirBuilder(page);

    await page.getByTestId(`node-test-${N2}`).click();

    const panneau = page.getByTestId('workflow-test-panel');
    await expect(panneau).toBeVisible();
    // Le mot et le lien portent le suffixe du bloc : sans lui, le test démarrerait à l'entrée du scénario.
    await expect(page.getByTestId('workflow-test-mot')).toHaveText(`${MOT_TEST}.${N2}`);
    await expect(page.getByTestId('workflow-test-lien')).toHaveValue(`https://wa.me/33525680250?text=${MOT_TEST}.${N2}`);
    // 🔴 ET LE TEXTE PRODUIT PASSE LE FILTRE DU SERVEUR. Sans cette ligne, les deux moitiés du lot sont
    // vertes chacune de son côté et personne ne vérifie qu'elles se parlent.
    const mot = await page.getByTestId('workflow-test-mot').textContent();
    expect(mot, 'le mot composé par le navigateur doit passer le filtre du chemin chaud').toMatch(FILTRE_SERVEUR);
    // Et le panneau le DIT : il promettait « le scénario démarre », ce qui est faux à partir d'un bloc.
    await expect(page.getByTestId('workflow-test-depuis-bloc')).toBeVisible();
    // Le QR est recalculé sur le lien AVEC le suffixe (data-URL, aucun service externe).
    await expect(panneau.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  });

  test('🔴 le clic n’ouvre PAS le panneau de configuration du bloc par-dessus', async ({ page }) => {
    // Sans `stopPropagation`, React Flow sélectionne aussi le bloc : le panneau de configuration remplace
    // l'invite de droite, et le testeur se retrouve avec deux panneaux ouverts sur le même geste.
    await ouvrirBuilder(page);
    const invite = page.getByText('Clique un bloc pour le configurer', { exact: false });
    await expect(invite).toBeVisible();

    await page.getByTestId(`node-test-${N2}`).click();

    await expect(page.getByTestId('workflow-test-panel')).toBeVisible();
    await expect(invite, 'aucun bloc ne doit avoir été sélectionné').toBeVisible();
  });

  test('⚠️ chaque bloc a SON bouton, et le premier donne son propre suffixe', async ({ page }) => {
    // Décision de Julien : TOUS les blocs portent le bouton, le bloc d'entrée compris. Le suffixe doit donc
    // suivre le bloc cliqué, pas être une constante.
    await ouvrirBuilder(page);
    await page.getByTestId(`node-test-${N1}`).click();
    await expect(page.getByTestId('workflow-test-mot')).toHaveText(`${MOT_TEST}.${N1}`);
  });

  test('🔴 une modification NON ENREGISTRÉE part AVANT que le panneau s’ouvre', async ({ page }) => {
    // 🔴 C'est la seule chose qui rend le bouton juste sur un bloc qu'on vient de modifier : le lien fait jouer
    // le brouillon tel que le SERVEUR le connaît, et l'enregistrement automatique attend 1,2 s. Sans le vidage
    // de la file, tester dans la seconde qui suit une modification ferait jouer la version PRÉCÉDENTE, et rien
    // à l'écran ne le dirait.
    //
    // ⚠️ CE TEST EST UNE COURSE, et il faut le savoir : il vaut parce que la saisie puis le clic prennent bien
    // moins que les 1,2 s du debounce. S'il devenait plus lent que ça, l'enregistrement automatique aurait déjà
    // eu lieu et le test passerait pour la mauvaise raison. Il ne peut donc rendre un FAUX ÉCHEC, seulement un
    // faux succès : vérifié par mutation le 2026-09-16 (vidage retiré, ce test tombe).
    const { appels } = await ouvrirBuilder(page);

    // Sélectionne le bloc par un clic sur son corps (pas sur le bouton lecture), puis modifie son message.
    await page.locator('.react-flow__node').nth(1).click();
    await page.getByTestId('quick-node-body').fill('version toute fraiche');
    await page.getByTestId(`node-test-${N2}`).click();

    await expect(page.getByTestId('workflow-test-panel')).toBeVisible();
    const rangPatch = appels.findIndex((a) => a.includes('version toute fraiche'));
    const rangTest = appels.indexOf('test-link');
    expect(rangPatch, 'le brouillon modifié doit avoir été envoyé').toBeGreaterThan(-1);
    expect(rangTest, 'le lien de test doit avoir été demandé').toBeGreaterThan(-1);
    expect(rangPatch, 'le brouillon part AVANT la demande du lien').toBeLessThan(rangTest);
  });
});
