import { test, expect } from '@playwright/test';

/**
 * Onglet TESTER : parler à son agent avant de l'activer.
 *
 * Ce qu'on vérifie vraiment ici : le panneau ne montre pas que la réponse. Il montre les OUTILS que l'agent
 * a choisi d'appeler, avec leurs arguments, et il DIT lesquels ont été simulés. Sans ça, le client règle à
 * l'aveugle : il voit une belle réponse sans savoir si elle vient de sa base de connaissance ou de ce que le
 * modèle a imaginé, et il croit qu'un tag a été posé alors que rien n'a eu lieu.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const AG = '11111111-1111-4111-8111-111111111111';

const AGENT = {
  id: AG, label: 'Conseiller séjours', status: 'draft',
  mentionIa: 'Vous échangez avec un assistant automatique.', modele: 'modele-test',
  maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30000, inactiviteMinutes: 30,
  contactInconnu: 'lecture_seule',
  contenu: { nom: '', objectif: 'Aider.', ton: '', personnalite: '', reglesTransfert: '', sorties: [] },
  ficheVersion: 4,
};

const REPONSE = {
  texte: 'La piscine est ouverte de 9 h à 20 h.',
  sortie: null,
  appels: [
    {
      nom: 'mba_chercher_connaissance',
      arguments: '{"requete":"horaires de la piscine"}',
      status: 'ok',
      contenu: { sources: [{ titre: 'La piscine', contenu: 'Ouverte de 9 h à 20 h.', url: 'https://exemple.fr/p' }] },
    },
    {
      nom: 'mba_poser_tag',
      arguments: '{"tag":"interesse_piscine"}',
      status: 'ok',
      contenu: { simule: true, tag: 'interesse_piscine', note: 'Test hors ligne : la pose du tag n\'a PAS eu lieu.' },
    },
  ],
  usage: { tokensIn: 1200, tokensOut: 80, coutMicroEur: 40 },
};

/** Un essai ARCHIVE, tel que la liste le rend. Ses appels sont plus maigres que ceux d'un essai frais :
 *  le nom et le statut, jamais ce que l'outil a rendu. */
const ARCHIVE = {
  id: 'e-1',
  messages: [{ role: 'user', content: 'Vous avez une piscine ?' }],
  reponse: 'La piscine est ouverte de 9 h à 20 h.',
  sortie: null,
  appels: [{ nom: 'mba_chercher_connaissance', status: 'ok' }],
  // Un ordre de grandeur REEL : ~1300 jetons sur le modele de production coutent des dixiemes de millieme
  // d'euro. C'est ce qui rend le format d'affichage decisif (cf. le test du cout).
  tokensEntree: 1200, tokensSortie: 80, coutMicroEur: 720,
  createdAt: '2026-09-08T08:30:00.000Z',
};

type Appel = { method: string; url: string; body: unknown };

async function mock(
  page: import('@playwright/test').Page,
  appels: Appel[],
  essai?: { status: number; body: unknown },
  historique: unknown[] = [],
) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/tests$/.test(url)) return json({ essais: historique });
    if (/\/test$/.test(url)) {
      appels.push({ method: req.method(), url, body: req.postDataJSON() });
      const r = essai ?? { status: 200, body: REPONSE };
      return json(r.body, r.status);
    }
    if (/\/tools/.test(url)) return json({ outils: [], catalogue: [] });
    if (/\/knowledge/.test(url)) return json({ fiches: [] });
    if (new RegExp(`/agents/${AG}$`).test(url)) return json({ agent: AGENT });
    if (/\/agents(\?|$)/.test(url)) return json({ agents: [{ id: AG, label: 'Conseiller séjours', status: 'draft', sorties: [] }] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Agents IA : tester', () => {
  test('🔴 le panneau montre les OUTILS appelés, pas seulement la réponse', async ({ page }) => {
    // C'est ce qui distingue un test utile d'une démonstration : le client doit voir si la réponse vient de
    // sa base de connaissance ou de ce que le modèle a imaginé.
    const appels: Appel[] = [];
    await mock(page, appels);
    await page.goto(`/agents?id=${AG}&tab=tester`);

    await expect(page.getByTestId('test-vide')).toBeVisible();
    await page.getByTestId('test-saisie').fill('Vous avez une piscine ?');
    await page.getByTestId('test-envoyer').click();

    await expect(page.getByTestId('test-tour-assistant')).toContainText('9 h à 20 h');
    await expect(page.getByTestId('test-appels')).toBeVisible();
    await expect(page.getByTestId('test-appel-0')).toContainText('mba_chercher_connaissance');
    // Les arguments bruts sont montrés : c'est ce qu'on veut lire pour comprendre ce que l'agent a cherché.
    await expect(page.getByTestId('test-appel-0')).toContainText('horaires de la piscine');
  });

  test('🔴 un outil SIMULÉ est signalé comme tel', async ({ page }) => {
    // Le taire ferait croire qu'un tag a été posé, et le client réglerait la suite de sa conversation sur une
    // prémisse fausse.
    await mock(page, []);
    await page.goto(`/agents?id=${AG}&tab=tester`);
    await page.getByTestId('test-saisie').fill('Vous avez une piscine ?');
    await page.getByTestId('test-envoyer').click();

    await expect(page.getByTestId('test-simule-1')).toBeVisible();
    await expect(page.getByTestId('test-appel-1')).toContainText('Rien n’a eu lieu pour de vrai');
    // Et l'outil qui a VRAIMENT tourné n'est pas marqué simulé.
    await expect(page.getByTestId('test-simule-0')).toHaveCount(0);
  });

  test('ce que l’outil a reçu est consultable', async ({ page }) => {
    await mock(page, []);
    await page.goto(`/agents?id=${AG}&tab=tester`);
    await page.getByTestId('test-saisie').fill('Vous avez une piscine ?');
    await page.getByTestId('test-envoyer').click();
    await page.getByTestId('test-appel-detail-0').click();
    await expect(page.getByTestId('test-appel-0')).toContainText('"titre": "La piscine"');
  });

  test('🔴 une SORTIE est annoncée, avec ce qu’elle veut dire pour le scénario', async ({ page }) => {
    await mock(page, [], {
      status: 200,
      body: { texte: null, sortie: 'sans_source', appels: [], usage: { tokensIn: 300, tokensOut: 10, coutMicroEur: 8 } },
    });
    await page.goto(`/agents?id=${AG}&tab=tester`);
    await page.getByTestId('test-saisie').fill('Quelle est la capitale de la Mongolie ?');
    await page.getByTestId('test-envoyer').click();
    await expect(page.getByTestId('test-sortie')).toContainText('sans_source');
    await expect(page.getByTestId('test-sortie')).toContainText('c’est cette branche du bloc qui prendrait la suite');
  });

  test('l’historique est renvoyé à chaque tour, pour que l’agent suive la conversation', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels);
    await page.goto(`/agents?id=${AG}&tab=tester`);
    await page.getByTestId('test-saisie').fill('Bonjour');
    await page.getByTestId('test-envoyer').click();
    await expect(page.getByTestId('test-tour-assistant')).toBeVisible();
    await page.getByTestId('test-saisie').fill('Et le parking ?');
    await page.getByTestId('test-envoyer').click();

    await expect.poll(
      () => (appels.at(-1)?.body as { messages?: unknown[] })?.messages?.length,
      { timeout: 5000 },
    ).toBe(3); // le premier message, la réponse de l'agent, puis la relance
  });

  /**
   * 🔴 L'HISTORIQUE. Julien, le 2026-09-08 : « j'ai voulu réappuyer et j'ai plus la trace de ce que j'ai
   * lu ». Régler un agent, c'est COMPARER : on repose la MÊME question après avoir changé une consigne.
   */
  test('les essais précédents sont relisibles, avec ce que l’agent avait appelé', async ({ page }) => {
    await mock(page, [], undefined, [ARCHIVE]);
    await page.goto(`/agents?id=${AG}&tab=tester`);
    const ligne = page.getByTestId(`test-essai-${ARCHIVE.id}`);
    await expect(ligne).toContainText('Vous avez une piscine ?');
    // L'outil appelé est visible sans ouvrir : c'est ce qui distingue « il n'a pas trouvé » de « il n'a
    // même pas cherché », la première question devant une mauvaise réponse.
    await expect(ligne).toContainText('mba_chercher_connaissance');
    // 🔴 Le coût d'un essai vaut des DIXIÈMES DE MILLIÈME d'euro. Au format à deux décimales des tableaux
    // de bord (0,00 €), l'écran laisserait croire que régler son agent est gratuit, et le client ne
    // pourrait pas voir qu'une consigne l'a rendu dix fois plus cher.
    await expect(page.getByTestId(`test-essai-cout-${ARCHIVE.id}`)).toContainText('0,0007');
    await page.getByTestId(`test-essai-ouvrir-${ARCHIVE.id}`).click();
    await expect(page.getByTestId(`test-essai-detail-${ARCHIVE.id}`)).toContainText('9 h à 20 h');
  });

  test('🔴 « Reprendre » repose EXACTEMENT la même question, sans la retaper', async ({ page }) => {
    // Une comparaison sur une question retapée ne compare rien : c'est tout l'intérêt du bouton.
    const appels: Appel[] = [];
    await mock(page, appels, undefined, [ARCHIVE]);
    await page.goto(`/agents?id=${AG}&tab=tester`);
    await page.getByTestId(`test-essai-reprendre-${ARCHIVE.id}`).click();
    await expect(page.getByTestId('test-tour-assistant')).toContainText('9 h à 20 h');
    expect(appels.at(-1)?.body).toEqual({ messages: ARCHIVE.messages });
  });

  test('un historique vide n’encombre pas l’écran', async ({ page }) => {
    await mock(page, []);
    await page.goto(`/agents?id=${AG}&tab=tester`);
    await expect(page.getByTestId('test-vide')).toBeVisible();
    await expect(page.getByTestId('test-historique')).toHaveCount(0);
  });

  test('une indisponibilité est ANNONCÉE, pas avalée', async ({ page }) => {
    await mock(page, [], { status: 503, body: { error: 'test indisponible (aucun modèle configuré côté serveur)' } });
    await page.goto(`/agents?id=${AG}&tab=tester`);
    await page.getByTestId('test-saisie').fill('Bonjour');
    await page.getByTestId('test-envoyer').click();
    await expect(page.getByTestId('test-erreur')).toContainText('indisponible');
  });
});
