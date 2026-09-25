import { test, expect, type Page, type Route } from '@playwright/test';
import { SESSION, ouvrirAssistant } from './aide/assistant';

/**
 * CRÉER UN MODÈLE SANS QUITTER LA CAMPAGNE : ce que l'écran doit faire pendant la revue Meta.
 *
 * 🔴 CE FICHIER REMPLACE `campaign-template-a-la-volee.spec.ts` ET `campagne-template-colonne-etroite.spec.ts`,
 * qui exerçaient ces cas sur l'écran retiré le 2026-09-13. Le parcours, lui, n'a PAS été refait : il a été
 * extrait tel quel dans `CreationModeleEnLigne`, et ce sont les mêmes cas qui le gardent.
 *
 * Vécu à corriger, et toujours gardé ici : le panneau annonçait « statut : PENDING » puis ne bougeait plus.
 * Le bouton rechargeait bien les modèles, mais filtrés sur APPROVED et pour le SÉLECTEUR fermé au-dessus.
 * On croyait le bouton cassé, alors que Meta avait déjà approuvé : il fallait fermer le panneau pour s'en
 * apercevoir.
 */

/** Un SECOND modèle, déjà approuvé, disponible dans le sélecteur pendant l'attente. */
const AUTRE = {
  id: 'T2', name: 'relance_juin', status: 'APPROVED', category: 'MARKETING', language: 'fr',
  body: 'Une relance', headerFormat: null, isCarousel: false, editable: true,
};
const TPL = (status: string) => ({
  id: 'T1', name: 'testurl', status, category: 'MARKETING', language: 'fr',
  body: 'Bonjour', headerFormat: null, isCarousel: false, editable: true,
});

/**
 * Faux backend dont le statut du modèle ÉVOLUE : au bout de `approuveApres` lectures, Meta a approuvé.
 *
 * ⚠️ SANS CETTE ÉVOLUTION, AUCUN TEST NE POURRAIT DISTINGUER « l'écran redemande » de « l'écran n'a rien
 * fait » : les deux afficheraient le même panneau figé.
 */
async function faux(page: Page, statutFixe?: string, approuveApres = 1): Promise<{ lectures: number }> {
  const etat = { lectures: 0 };
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route: Route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname.replace('/api/backend', '');
    const method = req.method();
    const json = (b: unknown, status = 200): Promise<void> =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.includes('/param-hints')) return json({ hints: [] });
    if (chemin.includes('/templates')) {
      if (method === 'POST') return json({ id: 'T1', status: 'PENDING' }, 201);
      etat.lectures += 1;
      const statut = statutFixe ?? (etat.lectures > approuveApres ? 'APPROVED' : 'PENDING');
      return json({ templates: [TPL(statut), AUTRE] });
    }
    if (chemin.includes('/flows')) return json({ flows: [] });
    if (chemin.includes('/contacts/count')) return json({ total: 0 });
    if (chemin.includes('/contacts')) return json({ contacts: [] });
    if (chemin.includes('/unread-count')) return json({ count: 0 });
    if (chemin.includes('/campaign-drafts')) return json({ drafts: [] });
    if (chemin.includes('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33525680250', verifiedName: 'Demo' }] });
    if (chemin.endsWith('/rcs-agents')) return json({ agents: [] });
    if (chemin.endsWith('/rcs-messages')) return json({ messages: [] });
    /**
     * 🔴 L'ADRESSE RÉELLE EST `/email/templates`, PAS `/email-templates` (corrigé le 2026-09-14). Ce faux
     * a porté la mauvaise adresse depuis sa création : l'appel retombait sur la règle `/templates` juste
     * en dessous, et la console recevait donc la liste des modèles WHATSAPP comme gabarits d'e-mail. Rien
     * ne le signalait tant qu'aucun test ne remplissait un étage e-mail.
     */
    if (chemin.endsWith('/email/templates')) return json({ templates: [] });
    if (chemin.endsWith('/workflows')) return json({ workflows: [] });
    if (chemin.endsWith('/users')) return json({ users: [] });
    if (chemin.endsWith('/agents')) return json({ agents: [] });
    if (chemin.includes('/user-fields')) return json({ fields: [] });
    if (chemin.endsWith('/tags')) return json({ tags: [] });
    if (chemin.endsWith('/me')) return json({ email: SESSION.email, name: 'Jean Test', role: 'admin' });
    if (chemin.endsWith('/settings')) {
      return json({
        mbaEnabled: false, rcsEnabled: false, hubspotListsEnabled: false, campaignsPaused: false,
        autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null,
        timezone: 'Europe/Paris', businessHours: {},
      });
    }
    if (chemin.endsWith('/campaigns')) return json({ campaigns: [] });
    return json({});
  });
  return etat;
}

/** Ouvre le cadre WhatsApp de l'assistant et soumet un modèle à la volée. */
async function soumettreUnModele(page: Page): Promise<void> {
  await ouvrirAssistant(page, { etape: 'contenu', canal: 'whatsapp' });
  await page.getByTestId('etage-1').click();
  await page.getByTestId('creer-modele').click();
  await page.getByPlaceholder('promo_ete').fill('testurl');
  // Le corps est un contentEditable (il porte des jetons de variable), pas un `<textarea>` : on tape dedans.
  const corps = page.getByRole('textbox', { name: /Corps du message|Message body/ });
  await corps.click();
  await corps.pressSequentially('Bonjour, voici notre offre');
  await page.getByRole('button', { name: /^Créer le template$/ }).click();
  await expect(page.getByTestId('template-soumis')).toBeVisible({ timeout: 15_000 });
}

test.describe('Assistant : un modèle créé à la volée', () => {
  test('🔴 « Vérifier maintenant » RAPPORTE l’approbation à l’écran', async ({ page }) => {
    await faux(page);
    await soumettreUnModele(page);
    await expect(page.getByTestId('template-soumis')).toContainText('statut : en revue');
    await page.getByTestId('verifier-statut').click();
    await expect(page.getByTestId('template-soumis')).toContainText(/approuvé par Meta/);
  });

  test('🔴 une fois approuvé, le modèle est SÉLECTIONNÉ tout seul pour l’étage', async ({ page }) => {
    await faux(page);
    await soumettreUnModele(page);
    await page.getByTestId('verifier-statut').click();
    // Le sélecteur de l'étage le porte : l'opérateur n'a pas à le rechoisir à la main.
    await expect(page.getByTestId('modele-1')).toHaveValue('testurl', { timeout: 15_000 });
  });

  test('🔴 l’écran vérifie TOUT SEUL, sans le moindre clic', async ({ page }) => {
    // C'est la demande de fond : ne pas laisser le client devant un bouton qu'il faut penser à cliquer.
    // Le sondage bat toutes les 15 s, d'où la patience explicite.
    test.setTimeout(90_000);
    await faux(page);
    await soumettreUnModele(page);
    await expect(page.getByTestId('template-soumis')).toContainText('statut : en revue');
    await expect(page.getByTestId('template-soumis')).toContainText(/approuvé par Meta/, { timeout: 45_000 });
  });

  /**
   * 🔴 UN CHOIX FAIT PENDANT L'ATTENTE N'EST JAMAIS ÉCRASÉ, ET LA PHRASE NE MENT PAS. Le garde-fou
   * existait, mais le panneau annonçait « il est sélectionné » sans savoir si quoi que ce soit l'avait
   * été : l'opérateur lançait sur cette assurance, avec l'AUTRE modèle.
   */
  test('🔴 un choix fait PENDANT l’attente n’est jamais écrasé, et la phrase ne ment pas', async ({ page }) => {
    await faux(page);
    await soumettreUnModele(page);
    await page.getByTestId('modele-1').selectOption('relance_juin');
    await page.getByTestId('verifier-statut').click();
    await expect(page.getByTestId('template-soumis')).toContainText(/approuvé par Meta/);
    await expect(page.getByTestId('modele-1')).toHaveValue('relance_juin');
    await expect(page.getByTestId('template-soumis')).toContainText(/Choisissez-le dans la liste/);
    await expect(page.getByTestId('template-soumis')).not.toContainText(/Il est sélectionné/);
  });

  test('🔴 le sondage S’ARRÊTE sur un statut terminal', async ({ page }) => {
    // Sans condition d'arrêt, on continuerait d'appeler Meta toutes les 15 s pour rien, sur un panneau que
    // l'opérateur peut laisser ouvert des heures.
    test.setTimeout(90_000);
    const etat = await faux(page);
    await soumettreUnModele(page);
    await page.getByTestId('verifier-statut').click();
    await expect(page.getByTestId('template-soumis')).toContainText(/approuvé par Meta/);
    const apres = etat.lectures;
    await page.waitForTimeout(35_000);
    expect(etat.lectures - apres).toBeLessThanOrEqual(1);
  });

  test('🔴 un refus est annoncé comme tel, et n’invente pas le motif', async ({ page }) => {
    await faux(page, 'REJECTED');
    await soumettreUnModele(page);
    await page.getByTestId('verifier-statut').click();
    await expect(page.getByTestId('template-soumis')).toContainText(/refusé par Meta/);
    // Le motif n'est pas dans la liste des modèles : l'écran renvoie là où Meta l'affiche, sans le deviner.
    await expect(page.getByTestId('template-soumis')).toContainText(/écran Modèles/);
    // Et il n'y a plus de bouton de vérification : le statut est terminal.
    await expect(page.getByTestId('verifier-statut')).toHaveCount(0);
  });

  /**
   * 🔴 LE PANNEAU SURVIT AU REPLIAGE DU CADRE, ET C'EST LA PROMESSE QU'IL FAIT : « il sera sélectionné dès
   * qu'il est approuvé ». Rangé dans le cadre de l'étage, replier ce cadre l'effacerait, et la promesse
   * disparaîtrait sans un mot, ce qui est pire que de ne pas l'avoir faite. Il vit donc dans la coquille.
   */
  test('🔴 replier le cadre de l’étage n’efface PAS le suivi de la revue', async ({ page }) => {
    await faux(page);
    await soumettreUnModele(page);
    await page.getByTestId('etage-1').getByRole('button').first().click(); // replie
    await expect(page.getByTestId('template-soumis')).toHaveCount(0);
    await page.getByTestId('etage-1').getByRole('button').first().click(); // rouvre
    await expect(page.getByTestId('template-soumis')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('template-soumis')).toContainText('testurl');
  });
});

/**
 * LE FORMULAIRE DE MODÈLE RESTE LISIBLE DANS LA COLONNE DE L'ASSISTANT.
 *
 * 🔴 CE QUI ÉTAIT CASSÉ, ET IL A FALLU LE MESURER POUR LE VOIR. Julien, le 2026-09-08 : « selon la taille
 * de l'écran, la miniature du template passe au-dessus des cases à remplir, c'est illisible ». Ce n'était
 * pas un chevauchement : l'aperçu prend 300 px FIXES à côté du formulaire, et la colonne de l'assistant
 * est bornée à 768 px, dont il reste environ 700 utiles dans un cadre d'étage.
 *
 * ⚠️ AUCUNE MEDIA QUERY NE POUVAIT CORRIGER ÇA : les points de rupture lisent la largeur de l'ÉCRAN. À
 * 1280, la page Modèles dispose de ~900 px et veut ses deux colonnes ; le cadre d'un étage, lui, n'en veut
 * qu'une. D'où le drapeau `colonneEtroite`, posé par l'appelant qui SAIT dans quoi il rend.
 *
 * ⚠️ CE TEST MESURE AU LIEU DE DÉCRIRE : une assertion sur une classe CSS passerait au vert le jour où la
 * classe existe sans plus rien produire.
 */
const LARGEUR_MINIMALE = 240;

test.describe('Assistant : le formulaire de modèle reste lisible dans sa colonne', () => {
  for (const largeur of [1280, 1440, 1600, 1920]) {
    test(`🔴 à ${largeur} px, les champs restent utilisables`, async ({ page }) => {
      await page.setViewportSize({ width: largeur, height: 900 });
      await faux(page);
      await ouvrirAssistant(page, { etape: 'contenu', canal: 'whatsapp' });
      await page.getByTestId('etage-1').click();
      await page.getByTestId('creer-modele').click();

      const champNom = page.getByPlaceholder('promo_ete');
      await expect(champNom).toBeVisible({ timeout: 15_000 });
      const nom = (await champNom.boundingBox())!;
      expect(Math.round(nom.width), `le champ « Nom » ne fait que ${Math.round(nom.width)} px : l’aperçu a repris la place`)
        .toBeGreaterThan(LARGEUR_MINIMALE);

      // Et l'aperçu est bien SOUS le formulaire, pas à côté : c'est ce qui rend la largeur au formulaire.
      const apercu = (await page.getByTestId('apercu-whatsapp').boundingBox())!;
      expect(apercu.y, 'l’aperçu est resté à côté des champs au lieu de passer dessous').toBeGreaterThan(nom.y);
    });
  }

  test('🔴 preuve inverse : sur SA PROPRE PAGE, l’aperçu reste À CÔTÉ du formulaire', async ({ page }) => {
    // Sans ce cas, empiler l'aperçu partout passerait le test ci-dessus, et la page Modèles perdrait sa
    // mise en page à deux colonnes alors qu'elle a toute la largeur voulue.
    await page.setViewportSize({ width: 1440, height: 900 });
    await faux(page);
    await page.goto('/templates');
    await page.getByRole('button', { name: /Créer un template|Create a template/ }).first().click();
    const champNom = page.getByPlaceholder('promo_ete');
    await expect(champNom).toBeVisible({ timeout: 15_000 });
    const nom = (await champNom.boundingBox())!;
    const apercu = (await page.getByTestId('apercu-whatsapp').boundingBox())!;
    expect(apercu.x, 'l’aperçu est passé sous le formulaire alors que la page a la place pour deux colonnes')
      .toBeGreaterThan(nom.x + nom.width);
  });
});
