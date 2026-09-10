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
 *  - un appel PAS ENCORE ENREGISTRÉ s'essaie : sans ça, le premier appel d'un client était impossible à
 *    créer (enregistrer exige un champ de sortie, qui se coche dans la réponse d'un essai) ;
 *  - l'écran s'ouvre sur la LISTE des systèmes ; les appels d'un système apparaissent quand on le déplie.
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
  // ⚠️ L'ÉCRAN S'OUVRE SUR LA LISTE, PAS SUR TOUT. Il dépliait auparavant chaque système en grande fiche, le
  // formulaire « brancher un système » ouvert au MILIEU, puis les appels de tous les systèmes à la suite. On
  // déplie donc celui qu'on vient travailler, ce que fait aussi un client.
  await page.getByTestId(`source-ligne-${SRC}`).click();
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

  test('🔴 un appel PAS ENCORE ENREGISTRÉ s’essaie, sinon on ne peut en créer AUCUN', async ({ page }) => {
    // MÊME CAS QU'AVANT (un brouillon jamais enregistré), VERDICT INVERSE, et c'est le sujet : ce test figeait
    // un cycle fermé. Enregistrer exige au moins un champ de sortie ; ces champs se cochent dans la réponse
    // d'un essai ; et l'essai exigeait un appel enregistré. Le premier appel d'un client était donc
    // impossible, et aucun test de route ne pouvait le voir : ils créent leurs requêtes par l'API, donc ils
    // n'empruntent jamais le chemin de l'écran.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture);
    await page.getByTestId('requete-nouvelle').click();
    await page.getByTestId('requete-chemin').fill('/flow/subflows');

    await expect(page.getByTestId('requete-essayer')).toBeEnabled();
    await page.getByTestId('requete-essayer').click();
    await expect(page.getByTestId('reponse-statut')).toContainText('200');

    // 🔴 ET L'APPEL PART SUR LA ROUTE DU BROUILLON, sans identifiant : c'est ce qui prouve qu'on éprouve ce
    // qui est À L'ÉCRAN. L'ancienne route (`/:id/test`) éprouvait la version stockée, donc une adresse que le
    // client venait justement de changer.
    const essai = capture.posts.find((p) => p.url.endsWith('/agent-requetes/test'));
    expect(essai).toBeTruthy();
    expect((essai!.body as { chemin: string }).chemin).toBe('/flow/subflows');

    // Et le cycle s'ouvre pour de bon : on coche un champ, on nomme l'appel, on peut enregistrer.
    // ⚠️ Le NOM aussi est exigé, et ce test l'a d'abord oublié : « Enregistrer » restait gris pour une raison
    // parfaitement légitime, ce qui est le meilleur rappel que ce bouton a TROIS conditions, pas une.
    await page.getByTestId('chemin-statut').check();
    await expect(page.getByTestId('requete-enregistrer')).toBeDisabled();
    await page.getByTestId('requete-label').fill('Lister les scénarios');
    await expect(page.getByTestId('requete-enregistrer')).toBeEnabled();
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
