import { test, expect } from '@playwright/test';
import { mockMba, appelsMba } from './support/mba';

/**
 * Le chargement en lot. C'est la pièce la plus délicate de l'écran, parce que l'API Meta n'a NI suppression en
 * lot NI corbeille : un import raté se rattrape entrée par entrée, à la main.
 */

const CSV = 'question,réponse\nLes vélos ?,Pliants uniquement.\nHoraires ?,6h-22h en été\n';
const APERCU = {
  source: 'csv',
  total: 3,
  aCreer: [{ question: 'Les vélos ?', answer: 'Pliants uniquement.' }],
  aMettreAJour: [{ id: '2', question: 'Horaires ?', answer: '6h-22h en été' }],
  inchangees: 1,
};

test.describe('MBA Paramètres : import de FAQ', () => {
  test('🔴 aucun import possible tant qu’un aperçu n’a pas été rendu', async ({ page }) => {
    const calls = await mockMba(page, { preview: APERCU });
    await page.goto('/mba/parametres?tab=faq');
    await page.getByTestId('mba-faq-import-open').click();

    await page.getByTestId('mba-import-csv').fill(CSV);
    await expect(page.getByTestId('mba-import-confirm')).toBeDisabled();
    expect(appelsMba(calls, 'POST', '/faq/import')).toHaveLength(0);
  });

  test('analyse puis confirmation : les trois catégories, puis l’écriture', async ({ page }) => {
    const calls = await mockMba(page, {
      preview: APERCU,
      importResult: { source: 'csv', created: 1, updated: 1, unchanged: 1, remaining: 0, ids: { created: ['f9'], updated: ['2'] }, failed: null },
    });
    await page.goto('/mba/parametres?tab=faq');
    await page.getByTestId('mba-faq-import-open').click();
    await page.getByTestId('mba-import-csv').fill(CSV);
    await page.getByTestId('mba-import-analyse').click();

    await expect(page.getByTestId('mba-import-summary')).toContainText('1 à créer');
    await expect(page.getByTestId('mba-import-summary')).toContainText('1 à mettre à jour');
    await expect(page.getByTestId('mba-import-summary')).toContainText('1 inchangée');
    await expect(page.getByTestId('mba-import-tocreate')).toContainText('Les vélos ?');

    await page.getByTestId('mba-import-confirm').click();
    await expect(page.getByTestId('mba-import-result')).toContainText('1 créée');
    expect(appelsMba(calls, 'POST', '/faq/import')).toHaveLength(1);

    // 🔴 L'INVARIANT du panneau : ce qui est écrit est EXACTEMENT ce qui a été analysé. Compter les appels ne
    // prouve rien de leur contenu ; sans cette comparaison, une charge fabriquée au moment du clic passerait.
    const analysee = appelsMba(calls, 'POST', '/faq/preview')[0]?.body;
    const ecrite = appelsMba(calls, 'POST', '/faq/import')[0]?.body;
    expect(ecrite).toEqual(analysee);
    expect(ecrite).toEqual({ csv: CSV });
  });

  test('🔴 la charge importée est EXACTEMENT celle prévisualisée', async ({ page }) => {
    // Sans cet invariant, modifier le texte après l'aperçu puis cliquer Confirmer écrirait chez Meta quelque
    // chose que personne n'a jamais vu. Ici : on analyse, on modifie, et l'aperçu doit être périmé.
    const calls = await mockMba(page, { preview: APERCU });
    await page.goto('/mba/parametres?tab=faq');
    await page.getByTestId('mba-faq-import-open').click();
    await page.getByTestId('mba-import-csv').fill(CSV);
    await page.getByTestId('mba-import-analyse').click();
    await expect(page.getByTestId('mba-import-preview')).toBeVisible();

    const AUTRE = 'question,réponse\nAutre chose ?,Une autre réponse.\n';
    await page.getByTestId('mba-import-csv').fill(AUTRE);
    await expect(page.getByTestId('mba-import-preview')).toHaveCount(0);
    await expect(page.getByTestId('mba-import-confirm')).toBeDisabled();
    expect(appelsMba(calls, 'POST', '/faq/import')).toHaveLength(0);

    // Réanalysé puis confirmé : c'est la SECONDE charge qui part, pas la première qui avait été prévisualisée.
    await page.getByTestId('mba-import-analyse').click();
    await expect(page.getByTestId('mba-import-preview')).toBeVisible();
    await page.getByTestId('mba-import-confirm').click();
    await expect.poll(() => appelsMba(calls, 'POST', '/faq/import')[0]?.body).toEqual({ csv: AUTRE });
    expect(appelsMba(calls, 'POST', '/faq/preview').at(-1)?.body).toEqual({ csv: AUTRE });
  });

  test('🔴 une analyse dont la source a bougé pendant le vol est JETÉE, pas affichée', async ({ page }) => {
    // Le cas qui rend l'invariant réellement vérifiable. Sans le compteur de séquence, la frappe périme bien
    // l'aperçu, puis la réponse de l'analyse le RÉARME par-dessus, bouton de confirmation actif, alors que la
    // zone de texte affiche déjà autre chose : l'utilisateur valide un plan périmé présenté comme courant.
    // Les comparaisons de corps des autres tests ne peuvent pas voir ça, les deux valeurs y sont égales par
    // construction (toute modification désactive la confirmation).
    let analyses = 0;
    const calls = await mockMba(page, {
      custom: async (route, method, url) => {
        if (method === 'POST' && url.includes('/faq/preview')) {
          analyses += 1;
          await new Promise((r) => setTimeout(r, 1200));
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(APERCU) });
          return true;
        }
        return false;
      },
    });
    await page.goto('/mba/parametres?tab=faq');
    await page.getByTestId('mba-faq-import-open').click();

    await page.getByTestId('mba-import-csv').fill(CSV);
    await page.getByTestId('mba-import-analyse').click();
    // Frappe PENDANT que l'analyse est en vol : rien ne l'empêche, le champ n'est pas verrouillé.
    await page.getByTestId('mba-import-csv').fill(`${CSV}Les poussettes ?,Pliées.\n`);

    // On attend que la réponse de l'analyse soit bel et bien revenue avant de conclure.
    await expect.poll(() => analyses, { timeout: 8000 }).toBe(1);
    await page.waitForTimeout(1500);

    await expect(page.getByTestId('mba-import-preview')).toHaveCount(0);
    await expect(page.getByTestId('mba-import-confirm')).toBeDisabled();
    expect(appelsMba(calls, 'POST', '/faq/import')).toHaveLength(0);
    // Et l'écran n'est pas figé : on peut réanalyser ce qui est affiché.
    await expect(page.getByTestId('mba-import-analyse')).toBeEnabled();
  });

  test('mode fichier : le CSV déposé est analysé puis importé tel quel', async ({ page }) => {
    // Ce mode alimente le même état de façon ASYNCHRONE (lecture du fichier), et n'était emprunté par aucun test.
    const calls = await mockMba(page, {
      preview: APERCU,
      importResult: { source: 'csv', created: 1, updated: 1, unchanged: 1, remaining: 0, ids: { created: ['f9'], updated: ['2'] }, failed: null },
    });
    await page.goto('/mba/parametres?tab=faq');
    await page.getByTestId('mba-faq-import-open').click();
    await page.getByTestId('mba-import-mode-fichier').click();
    await page.getByTestId('mba-import-file').setInputFiles({ name: 'faq.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf8') });

    await expect(page.getByTestId('mba-import-analyse')).toBeEnabled();
    await page.getByTestId('mba-import-analyse').click();
    await expect(page.getByTestId('mba-import-preview')).toBeVisible();
    await page.getByTestId('mba-import-confirm').click();

    await expect.poll(() => appelsMba(calls, 'POST', '/faq/import')[0]?.body).toEqual({ csv: CSV });
    expect(appelsMba(calls, 'POST', '/faq/preview')[0]?.body).toEqual({ csv: CSV });
  });

  test('🔴 mode fichier : un second dépôt gagne, et l’aperçu du premier est périmé', async ({ page }) => {
    // La lecture d'un fichier est asynchrone et change la source en arrivant. Deux fichiers déposés coup sur
    // coup doivent laisser le SECOND en place, et aucun aperçu calculé sur le premier ne doit rester affiché
    // comme s'il décrivait le fichier montré à l'écran.
    const A = 'question,réponse\nFICHIER A ?,Réponse A.\n';
    const B = 'question,réponse\nFICHIER B ?,Réponse B.\n';
    const calls = await mockMba(page, { preview: APERCU });
    await page.goto('/mba/parametres?tab=faq');
    await page.getByTestId('mba-faq-import-open').click();
    await page.getByTestId('mba-import-mode-fichier').click();

    await page.getByTestId('mba-import-file').setInputFiles({ name: 'a.csv', mimeType: 'text/csv', buffer: Buffer.from(A, 'utf8') });
    await page.getByTestId('mba-import-analyse').click();
    await expect(page.getByTestId('mba-import-preview')).toBeVisible();

    // Second dépôt : l'aperçu du premier fichier doit disparaître, sinon il décrit un contenu qui n'est plus là.
    await page.getByTestId('mba-import-file').setInputFiles({ name: 'b.csv', mimeType: 'text/csv', buffer: Buffer.from(B, 'utf8') });
    await expect(page.getByTestId('mba-import-preview')).toHaveCount(0);
    await expect(page.getByTestId('mba-import-confirm')).toBeDisabled();

    // Et c'est bien le SECOND fichier qui est analysé puis écrit, pas le premier.
    await page.getByTestId('mba-import-analyse').click();
    await expect(page.getByTestId('mba-import-preview')).toBeVisible();
    await page.getByTestId('mba-import-confirm').click();
    await expect.poll(() => appelsMba(calls, 'POST', '/faq/import')[0]?.body).toEqual({ csv: B });
    expect(appelsMba(calls, 'POST', '/faq/preview').at(-1)?.body).toEqual({ csv: B });
  });

  test('🔴 mode fichier : une lecture qui atterrit après le clic ne fait PAS afficher l’aperçu du fichier précédent', async ({ page }) => {
    // L'entrelacement qui compte, et le seul moyen honnête de l'atteindre : la lecture d'un fichier est
    // asynchrone, et on la RALENTIT ici de façon déterministe (doublure de `Blob.prototype.text`, une API du
    // navigateur, pas du produit) pour qu'elle atterrisse forcément après le clic sur Analyser.
    //
    // Sans la garde de séquence dans la lecture, la suite est : le champ affiche b.csv, l'aperçu décrit a.csv,
    // et le bouton de confirmation est actif. L'écran mentirait sur ce qu'il décrit, sur une base de
    // connaissance Meta qui n'a ni corbeille ni suppression en lot.
    await page.addInitScript(() => {
      const vrai = Blob.prototype.text;
      Blob.prototype.text = function lente(this: Blob): Promise<string> {
        return new Promise((r) => { setTimeout(() => { void vrai.call(this).then(r); }, 900); });
      };
    });

    const A = 'question,réponse\nFICHIER A ?,Réponse A.\n';
    const B = 'question,réponse\nFICHIER B ?,Réponse B.\n';
    const calls = await mockMba(page, {
      custom: async (route, method, url) => {
        if (method === 'POST' && url.includes('/faq/preview')) {
          await new Promise((r) => setTimeout(r, 1500));
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(APERCU) });
          return true;
        }
        return false;
      },
    });
    await page.goto('/mba/parametres?tab=faq');
    await page.getByTestId('mba-faq-import-open').click();
    await page.getByTestId('mba-import-mode-fichier').click();

    // a.csv déposé et LU (on attend que le bouton s'active, preuve que le contenu est en place).
    await page.getByTestId('mba-import-file').setInputFiles({ name: 'a.csv', mimeType: 'text/csv', buffer: Buffer.from(A, 'utf8') });
    await expect(page.getByTestId('mba-import-analyse')).toBeEnabled();

    // b.csv déposé : sa lecture part et durera 900 ms. On clique Analyser tout de suite, donc sur a.csv.
    await page.getByTestId('mba-import-file').setInputFiles({ name: 'b.csv', mimeType: 'text/csv', buffer: Buffer.from(B, 'utf8') });
    await page.getByTestId('mba-import-analyse').click({ force: true });

    // Le temps que la lecture de b.csv atterrisse ET que la réponse d'analyse revienne.
    await page.waitForTimeout(3000);

    await expect(page.getByTestId('mba-import-preview')).toHaveCount(0);
    await expect(page.getByTestId('mba-import-confirm')).toBeDisabled();
    expect(appelsMba(calls, 'POST', '/faq/import')).toHaveLength(0);
  });

  test('🔴 import interrompu (207) : avertissement, reste à faire, et non-duplication annoncée', async ({ page }) => {
    // Une partie EST écrite. Peindre ça en rouge pousserait à tout relancer comme si rien n'était passé.
    await mockMba(page, {
      preview: APERCU,
      importResult: {
        source: 'csv', created: 1, updated: 0, unchanged: 1, remaining: 4,
        ids: { created: ['f9'], updated: [] },
        failed: { question: 'Horaires ?', error: 'Meta: rate limit' },
      },
    });
    await page.goto('/mba/parametres?tab=faq');
    await page.getByTestId('mba-faq-import-open').click();
    await page.getByTestId('mba-import-csv').fill(CSV);
    await page.getByTestId('mba-import-analyse').click();
    await page.getByTestId('mba-import-confirm').click();

    const bandeau = page.getByTestId('mba-import-result');
    await expect(bandeau).toContainText('Horaires ?');
    await expect(bandeau).toContainText('4 question');
    await expect(bandeau).toContainText('ne sera pas dupliqué');
    // Ambre et non rouge : le bandeau d'erreur ne doit PAS être celui utilisé pour un échec.
    await expect(page.getByTestId('mba-import-error')).toHaveCount(0);
  });

  test('source refusée par le serveur : le message remonte, rien n’est écrit', async ({ page }) => {
    const calls = await mockMba(page, {
      custom: async (route, method, url) => {
        if (method === 'POST' && url.includes('/faq/preview')) {
          await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'URL invalide ou non autorisée (http(s) et hôte public attendus)' }) });
          return true;
        }
        return false;
      },
    });
    await page.goto('/mba/parametres?tab=faq');
    await page.getByTestId('mba-faq-import-open').click();
    await page.getByTestId('mba-import-mode-url').click();
    await page.getByTestId('mba-import-url').fill('http://192.168.1.10/faq');
    await page.getByTestId('mba-import-analyse').click();

    await expect(page.getByTestId('mba-import-error')).toContainText('non autorisée');
    await expect(page.getByTestId('mba-import-confirm')).toBeDisabled();
    expect(appelsMba(calls, 'POST', '/faq/import')).toHaveLength(0);
  });
});
