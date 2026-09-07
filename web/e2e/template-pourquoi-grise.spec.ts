import { test, expect } from '@playwright/test';

/**
 * « Valider » grisé : l'écran DIT ce qui manque.
 *
 * 🔴 LE DÉFAUT VÉCU, rapporté par Julien le 2026-09-07 : il a saisi `htpps://` au lieu de `https://` dans
 * l'adresse d'un bouton, et le bouton « Créer le template » est resté grisé SANS RIEN DIRE. La raison
 * existait pourtant dans le code, mais elle vivait dans un attribut `title` : une infobulle qu'il faut
 * survoler à la souris, et qui n'existe pas au doigt.
 *
 * ⚠️ Ces specs ne vérifient PAS que le bouton se débloque. Il doit rester grisé tant qu'il manque quelque
 * chose : c'est la raison qui devient visible, pas la garde qui s'affaiblit.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

async function ouvrirFormulaire(page: import('@playwright/test').Page) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/templates/hints')) return json({ hints: [] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  // Le formulaire de creation s ouvre sur clic (« + Creer un template »), il n est pas monte d emblee.
  // Verifie dans `app/templates/page.tsx` apres un premier essai errone : c est le genre de detail qu on
  // croit savoir.
  await page.goto('/templates');
  await page.getByRole('button', { name: /Créer un template|Create a template/ }).click();
  await expect(page.getByTestId('template-nom')).toBeVisible({ timeout: 15_000 });
}

test.describe('le formulaire de template dit pourquoi il refuse', () => {
  test('🔴 C6 : un formulaire vide NOMME ce qui manque, au lieu d’un bouton inerte', async ({ page }) => {
    await ouvrirFormulaire(page);
    const manques = page.getByTestId('template-manques');
    await expect(manques).toBeVisible();
    // Les deux conditions de base, nommées et non devinées.
    await expect(manques).toContainText(/nom du template|template name/);
    await expect(manques).toContainText(/corps du message|message body/);
  });

  test('🔴 C7 : le `htpps` de Julien produit un message lisible qui DÉSIGNE le bouton fautif', async ({ page }) => {
    await ouvrirFormulaire(page);
    await page.getByTestId('template-nom').fill('promo_ete');
    await page.getByTestId('template-ajouter-lien').click();
    await page.getByTestId('template-bouton-texte-0').fill('Voir l offre');
    await page.getByTestId('template-bouton-url-0').fill('htpps://exemple.fr');

    const manques = page.getByTestId('template-manques');
    // Le rang du bouton EST dit : « un bouton est incomplet » sur un formulaire qui en porte trois laisse
    // chercher lequel.
    await expect(manques).toContainText(/bouton 1/);
    await expect(manques).toContainText(/https:\/\//);
    // 🔴 Et le bouton reste grisé : on rend la raison visible, on ne relâche pas la garde.
    await expect(page.getByRole('button', { name: /Créer le template|Create template/ })).toBeDisabled();
  });

  test('🔴 C6 : l’EN-TÊTE aussi, dans ses deux formes', async ({ page }) => {
    // Le bouton se grise sur cinq conditions. Trois etaient couvertes (nom, corps, bouton) ; l'en-tete est
    // la branche la plus subtile, parce qu'elle change de message selon la forme choisie.
    await ouvrirFormulaire(page);
    const manques = page.getByTestId('template-manques');

    await page.getByTestId('template-entete-type').selectOption('TEXT');
    await expect(manques).toContainText(/texte de l’en-tête|header text/);

    await page.getByTestId('template-entete-type').selectOption('IMAGE');
    await expect(manques).toContainText(/média de l’en-tête|header media/);
    // Preuve inverse : « Aucun » en-tete ne manque rien, la ligne disparait.
    await page.getByTestId('template-entete-type').selectOption('none');
    await expect(manques).not.toContainText(/en-tête|header/);

    // ⚠️ La cinquieme condition, `headerUploading`, n'est pas couverte ici : elle exige un envoi de fichier
    // reel en vol, et un test qui le simulerait testerait sa propre simulation. Elle partage la meme
    // branche d'affichage que les deux ci-dessus, et sa formulation est verifiee par la lecture du code.
  });

  test('🔴 C8, preuve inverse : l’adresse corrigée retire la ligne du bouton', async ({ page }) => {
    // Sans ceci, un message affiché en permanence passerait le test précédent sans rien prouver.
    //
    // ⚠️ On n'exige PAS que la liste disparaisse entièrement : le corps du message reste vide, et il doit le
    // rester dans ce test (son éditeur n'est pas un `textarea`, le remplir ici testerait autre chose). Ce
    // qui se prouve est exactement ce qui est en cause : la ligne du bouton s'en va quand l'adresse est
    // corrigée, et elle seule.
    await ouvrirFormulaire(page);
    await page.getByTestId('template-nom').fill('promo_ete');
    await page.getByTestId('template-ajouter-lien').click();
    await page.getByTestId('template-bouton-texte-0').fill('Voir l offre');
    await page.getByTestId('template-bouton-url-0').fill('htpps://exemple.fr');
    await expect(page.getByTestId('template-manques')).toContainText(/bouton 1/);

    await page.getByTestId('template-bouton-url-0').fill('https://exemple.fr');
    await expect(page.getByTestId('template-manques')).not.toContainText(/bouton 1/);
  });
});
