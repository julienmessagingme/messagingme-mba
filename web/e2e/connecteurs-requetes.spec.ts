import { test, expect } from '@playwright/test';

/**
 * METTRE AU POINT UN APPEL API, dans Tools > Connecteurs API.
 *
 * 🔴 CE QUE SEUL UN TEST DE BOUT EN BOUT VOIT ICI, et qui décide si un débutant s'en sort :
 *  - après l'essai, les champs de la réponse RÉELLE apparaissent EN CASES À COCHER. C'est ce qui remplace
 *    « écris `livraison.date` de tête », et une faute de frappe écrite de tête ne se verrait qu'en pleine
 *    conversation avec un contact ;
 *  - on ne peut PAS enregistrer sans avoir coché au moins un champ : le filtre de sortie n'est pas facultatif,
 *    c'est lui qui décide ce qui part chez le fournisseur du modèle ;
 *  - les deux façons de saisir un corps existent, et la bascule vers le JSON brut REPREND le travail fait ;
 *  - l'essai est refusé tant que l'appel n'est pas enregistré, parce que le serveur teste ce qui est EN BASE.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const SRC = '22222222-2222-4222-8222-222222222222';
const RQ = '33333333-3333-4333-8333-333333333333';

const SOURCE = {
  id: SRC, kind: 'http', label: 'ERP', baseUrl: 'https://api.client.fr/v1',
  authKind: 'bearer', authHeaderName: null, aAuthentification: true,
  status: 'active', lastOkAt: null, lastError: null, outilsActifs: 0, agents: 0,
};

const REQUETE = {
  id: RQ, tenantId: 't-e2e', sourceId: SRC, label: 'Chercher une commande',
  methode: 'GET', chemin: '/commandes/{ref}',
  parametres: [], entetes: [], corps: { mode: 'aucun' },
  variables: [{ nom: 'ref', type: 'string', origine: { type: 'modele' }, requis: true }],
  outputPaths: ['statut'], valeursTest: { ref: 'CMD-1' }, outils: 0,
  updatedAt: '2026-09-02T00:00:00.000Z',
};

/** La réponse d'essai : deux champs imbriqués et un tableau, parce que les trois se cochent différemment. */
const TEST_OK = {
  ok: true, httpStatus: 200, dureeMs: 42,
  envoye: { url: 'https://api.client.fr/v1/commandes/CMD-1', methode: 'GET', corps: null },
  apercu: '{"statut":"expédiée","livraison":{"date":"2026-09-02"},"lignes":[1,2]}',
  chemins: ['statut', 'livraison.date', 'lignes'],
  risqueMinimum: 'read',
};

async function mock(page: import('@playwright/test').Page, capture: { posts: Array<{ url: string; body: unknown }> }, over: { requetes?: unknown[]; test?: unknown } = {}) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' || req.method() === 'PATCH' || req.method() === 'DELETE') {
      capture.posts.push({ url, body: req.postDataJSON() ?? null });
      if (url.includes('/test')) return json(over.test ?? TEST_OK);
      if (url.includes('/agent-requetes')) return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ requete: REQUETE }) });
      return json({ ok: true });
    }
    if (url.includes('/agent-requetes')) {
      return json({
        requetes: over.requetes ?? [REQUETE], champs: ['ville'],
        catalogue: { contact: ['wa_id', 'nom'], systeme: ['derniere_saisie', 'maintenant'], entetesReserves: ['authorization', 'content-type'] },
      });
    }
    if (url.includes('/agent-sources')) return json({ sources: [SOURCE] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.includes('/settings')) return json({ mbaEnabled: false, rcsEnabled: false, hubspotListsEnabled: false, campaignsPaused: false });
    return json({});
  });
  await page.goto('/connecteurs');
  await expect(page.getByTestId('requetes-bloc')).toBeVisible();
}

test.describe('Connecteurs : mettre au point un appel', () => {
  test('🔴 après l’essai, on COCHE les champs de la réponse réelle', async ({ page }) => {
    // C'est le geste qui rend l'écran utilisable sans connaître les API : on voit ce que le système répond,
    // et on désigne ce qu'on garde, au lieu d'écrire un chemin de mémoire.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture);

    await page.getByTestId(`requete-editer-${RQ}`).click();
    await page.getByTestId('requete-essayer').click();

    await expect(page.getByTestId('reponse-statut')).toContainText('200');
    await expect(page.getByTestId('reponse-apercu')).toContainText('expédiée');
    // Un TABLEAU est proposé entier : l'extracteur ne descend pas dedans, donc `lignes.0` serait une case
    // qui ne rendrait jamais rien.
    await expect(page.getByTestId('chemin-lignes')).toBeVisible();

    await page.getByTestId('chemin-livraison.date').check();
    await expect(page.getByTestId('reponse-gardes')).toContainText('livraison.date');

    await page.getByTestId('requete-enregistrer').click();
    await expect.poll(() => capture.posts.some((p) => p.url.includes(RQ) && !p.url.includes('/test'))).toBe(true);
    const envoi = capture.posts.find((p) => p.url.includes(RQ) && !p.url.includes('/test'))!;
    expect((envoi.body as { outputPaths: string[] }).outputPaths).toEqual(['statut', 'livraison.date']);
  });

  test('🔴 sans champ coché, on ne peut pas enregistrer', async ({ page }) => {
    // Le filtre de sortie décide ce qui part chez le fournisseur du modèle. Le rendre facultatif reviendrait
    // à laisser passer la réponse entière par défaut, ce que personne n'aurait décidé.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture, { requetes: [{ ...REQUETE, outputPaths: [] }] });
    await page.getByTestId(`requete-editer-${RQ}`).click();
    await expect(page.getByTestId('requete-enregistrer')).toBeDisabled();
    await page.getByTestId('requete-essayer').click();
    await page.getByTestId('chemin-statut').check();
    await expect(page.getByTestId('requete-enregistrer')).toBeEnabled();
  });

  test('les DEUX façons de saisir un corps, et la bascule reprend le travail fait', async ({ page }) => {
    // Julien : « du json brut pour les mecs habitués et une liste de champs ». La bascule est à sens unique,
    // et l'écran le dit dans le libellé du bouton.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture);
    await page.getByTestId(`requete-editer-${RQ}`).click();
    await page.getByTestId('onglet-corps').click();

    await page.getByTestId('corps-mode-champs').check();
    await page.getByTestId('corps-champ-ajouter').click();
    await page.getByTestId('corps-champ-cle-0').fill('ville');
    await page.getByTestId('corps-champ-valeur-0').fill('Lyon');

    await page.getByTestId('corps-vers-json').click();
    // Le travail fait se retrouve dans le JSON : la bascule ne fait pas recommencer.
    await expect(page.getByTestId('corps-json')).toHaveValue(/"ville": "Lyon"/);
    await expect(page.getByTestId('corps-json-etat')).toContainText(/valide|valid/i);
  });

  test('un JSON cassé se voit TOUT DE SUITE, pas après un aller-retour serveur', async ({ page }) => {
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture);
    await page.getByTestId(`requete-editer-${RQ}`).click();
    await page.getByTestId('onglet-corps').click();
    await page.getByTestId('corps-mode-json').check();
    await page.getByTestId('corps-json').fill('{pas du json');
    await expect(page.getByTestId('corps-json-etat')).toContainText(/pas du JSON valide|not valid JSON/i);
  });

  test('🔴 une pastille insère la variable au curseur : rien à retenir', async ({ page }) => {
    // C'est ce qui remplace « souviens-toi d'écrire {{ville}} ». La syntaxe ne doit pas être une chose à
    // apprendre pour se servir de l'écran.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture);
    await page.getByTestId(`requete-editer-${RQ}`).click();
    await page.getByTestId('onglet-corps').click();
    await page.getByTestId('corps-mode-json').check();
    await page.getByTestId('corps-json').fill('{"r": "');
    await page.getByTestId('corps-json').focus();
    await page.getByTestId('pastille-ref').click();
    await expect(page.getByTestId('corps-json')).toHaveValue('{"r": "{{ref}}');
  });

  test('l’essai est REFUSÉ tant que l’appel n’est pas enregistré', async ({ page }) => {
    // Le serveur teste ce qui est EN BASE, avec les mêmes gardes que l'exécution. Laisser essayer un
    // brouillon ferait valider un appel qui n'existe pas.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture);
    await page.getByTestId('requete-nouvelle').click();
    await expect(page.getByTestId('requete-essayer')).toBeDisabled();
  });

  test('🔴 une requête UTILISÉE par un agent ne se supprime pas', async ({ page }) => {
    // La cascade rendrait l'agent muet sur ce geste-là, en production, sans que personne ne l'ait décidé.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture, { requetes: [{ ...REQUETE, outils: 2 }] });
    await expect(page.getByTestId(`requete-usage-${RQ}`)).toContainText('2');
    await expect(page.getByTestId(`requete-supprimer-${RQ}`)).toBeDisabled();
  });

  test('l’écran DIT que les en-têtes d’authentification ne se règlent pas ici', async ({ page }) => {
    // Le champ « en-têtes » d'un mini-Postman est l'endroit le plus naturel pour coller un jeton en clair. La
    // route le refuse ; l'écran doit l'annoncer AVANT la saisie, pas après.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture);
    await page.getByTestId(`requete-editer-${RQ}`).click();
    await page.getByTestId('onglet-entetes').click();
    await expect(page.getByText(/authorization/i)).toBeVisible();
  });
});
