import { test, expect } from '@playwright/test';
import { mockMba } from './support/mba';

/**
 * L'en-tête identitaire de l'écran de réglage de l'agent de Meta, et le menu passé en colonne.
 *
 * Deux propriétés, et la seconde protège les autres suites : un seul élément par identifiant d'onglet, à
 * toutes les largeurs. Le passage en colonne invite à rendre deux blocs (`hidden lg:flex` et `lg:hidden`),
 * ce qui ferait exister chaque `data-testid` en double et casserait les onze clics des cinq suites MBA.
 */
test.describe('MBA Paramètres : en-tête et menu en colonne', () => {
  test('l en-tete identifie l agent, et le menu ne se rend qu UNE fois', async ({ page }) => {
    await mockMba(page);
    await page.goto('/mba/parametres');

    await expect(page.getByTestId('entete-agent')).toBeVisible();
    await expect(page.getByTestId('entete-agent')).toContainText('Boutique Test');
    await expect(page.getByTestId('entete-agent-precision')).toContainText('+33 5 25 68 03 01');
    await expect(page.getByTestId('pastille-numero-statut')).toContainText('Compte opérationnel');
    await expect(page.getByTestId('entete-agent-messages')).toContainText('412');
    await expect(page.getByTestId('entete-agent-etapes')).toContainText('1 étape à finir');
    await expect(page.getByTestId('entete-agent-ratio')).toContainText('1 sur 2');

    // 🔴 CE QUE LE CHIFFRE MESURE DOIT ÊTRE ÉCRIT À CÔTÉ DE LUI. Sans l'aveu, un client lit 412 comme le
    // travail de l'agent, alors que le compte embrasse tout le fil.
    // 🔴 LES DEUX MOITIÉS DE L'AVEU SONT ASSERTÉES SÉPARÉMENT, et la première est celle que la revue finale
    // a réclamée : « messages échangés » EXCLUT les modèles sortants à deux écrans d'ici (Accueil,
    // Performance Lab), et ici il les inclut. Une légende qui ne dirait que la reprise laisserait le même
    // mot désigner deux périmètres dans la même console.
    await expect(page.getByTestId('entete-agent-messages')).toContainText('les envois de campagne');
    await expect(page.getByTestId('entete-agent-messages'))
      .toContainText('ce que votre équipe a écrit après une reprise');

    // L'étape mène à l'onglet où elle se règle : une liste de manques sans le geste se lit comme un reproche.
    await page.getByTestId('entete-etape-faq').click();
    await expect(page).toHaveURL(/tab=faq/);

    // 🔴 LE CAS QUI PROTEGE LES CINQ AUTRES SUITES : un seul element par testid d'onglet, a toutes les
    // largeurs. Deux listes rendues feraient tomber `toHaveCount(0)` du gate et les onze clics existants.
    await expect(page.getByTestId('mba-tab-apercu')).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.getByTestId('mba-tab-apercu')).toHaveCount(1);

    // 🔴 C'EST LA BARRE D'ONGLETS QUI DÉFILE, PAS LA PAGE. Un élément de grille a `min-width: auto` : sans
    // `min-w-0` sur la colonne du menu, la grille prend la largeur des onze onglets et c'est la page
    // ENTIÈRE qui défile de travers sur un téléphone. Mesuré avant le correctif : 1029 px pour 390.
    const debordement = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(debordement, 'la page déborde horizontalement').toBe(0);
  });

  test('🔴 ce qu on ne sait pas garde sa ligne, en gris et HORS du compte d etapes', async ({ page }) => {
    /**
     * LA CAPACITÉ QUI AVAIT DISPARU SANS QUE PERSONNE NE LE REMARQUE (revue finale du 2026-09-23).
     * `calculerCompletion` pose TOUJOURS une tâche `paiement`, `inconnue` et `requise` : le moyen de paiement
     * se lit derrière le statut BSP, que nous n'avons pas. L'ancien `MbaCompletion` l'affichait dans une
     * seconde liste grisée ; l'en-tête qui l'a remplacé ne gardait que les `a_faire`, et cette ligne n'était
     * plus nulle part. Aucun test ne la couvrait, et cinq textes continuaient de la promettre.
     *
     * 🔴 LES TROIS ASSERTIONS DISENT TROIS CHOSES DIFFÉRENTES, et la deuxième est celle qui compte : elle est
     * RENDUE, elle n'est PAS comptée comme une étape, et elle n'est PAS cliquable (elle ne se règle pas ici).
     */
    await mockMba(page);
    await page.goto('/mba/parametres');

    await expect(page.getByTestId('entete-agent-signalements'))
      .toContainText('Le moyen de paiement se lit derrière le statut BSP');
    // Le compte d'étapes n'a pas bougé : une seule tâche est `a_faire`, la FAQ.
    await expect(page.getByTestId('entete-agent-etapes')).toContainText('1 étape à finir');
    // Et pas de bouton : personne ne peut « ouvrir l'onglet » du moyen de paiement, il n'y en a pas.
    await expect(page.getByTestId('entete-etape-paiement')).toHaveCount(0);

    // ⚠️ ET LES FACULTATIFS RESTENT DEHORS. `connecteurs` est `inconnue` lui aussi, mais non requis : le
    // montrer poserait une ligne grise permanente qui ne dit rien de l'état de l'agent, et le serveur
    // l'exclut déjà de son propre compte d'indéterminées.
    await expect(page.getByTestId('entete-agent-signalements')).not.toContainText('Pas encore piloté');
  });

  test('🔴 sans la route de comptage, AUCUN chiffre, et l ecran marche', async ({ page }) => {
    // C'est la fenetre ou Vercel a publie l'ecran et ou l'API n'est pas encore deployee. C'est aussi le cas
    // d'un compte non administrateur, que la route refuse en 403 : l'ecran doit rester utilisable.
    await mockMba(page);
    await page.route('**/mba/**/messages', (r) => r.fulfill({ status: 404, body: '{}' }));
    await page.goto('/mba/parametres');
    await expect(page.getByTestId('entete-agent')).toBeVisible();
    await expect(page.getByTestId('entete-agent-messages')).toHaveCount(0);
    // L'écran n'est pas tombé en erreur : les onglets et le reste de l'en-tête sont là.
    await expect(page.getByTestId('mba-page-error')).toHaveCount(0);
    await expect(page.getByTestId('mba-tab-faq')).toBeVisible();
    await expect(page.getByTestId('entete-agent-etapes')).toContainText('1 étape à finir');
  });

  test('🔴 numero PRESENT mais agent pas ouvert par Meta : aucune etape, aucun chiffre', async ({ page }) => {
    // LE CROISEMENT QUE PERSONNE NE COUVRAIT, et c'est le cas COURANT d'un client qui vient de connecter
    // son numéro : `phoneNumberId` existe (il vient de `getAccountStatus`), donc les lectures partaient,
    // et `/completion` ne regarde pas l'éligibilité : elle rendait « aucune FAQ » en `a_faire`. L'en-tête
    // annonçait alors « 1 étape à finir » avec un bouton qui change l'URL et ne produit RIEN, la bannière
    // de blocage restant affichée quel que soit l'onglet demandé.
    await mockMba(page, { status: { eligible: false, onboarded: false, agentId: null, settings: null } });
    await page.goto('/mba/parametres');
    await expect(page.getByTestId('mba-gate-not-eligible')).toBeVisible();

    // L'IDENTITÉ RESTE, et c'est elle qui informe : le numéro, son nom, sa pastille d'état.
    await expect(page.getByTestId('entete-agent')).toContainText('Boutique Test');
    await expect(page.getByTestId('pastille-numero-statut')).toBeVisible();

    await expect(page.getByTestId('entete-agent-etapes')).toHaveCount(0);
    await expect(page.getByTestId('entete-agent-messages')).toHaveCount(0);
    await expect(page.getByTestId('entete-etape-faq'), 'un bouton qui ne mène nulle part').toHaveCount(0);
    // ⚠️ LES SIGNALEMENTS SUIVENT LE MÊME SORT, pour la même raison : la complétion n'est pas lue sur un
    // numéro que Meta n'a pas ouvert, et annoncer « vérifiez votre moyen de paiement » sur un agent qui
    // n'existe pas encore chez Meta enverrait le client régler une condition qui ne le bloque pas.
    await expect(page.getByTestId('entete-agent-signalements')).toHaveCount(0);
  });

  test('🔴 l en-tete est la MEME sur un ecran bloque, sans numero', async ({ page }) => {
    // Le blocage « aucun numéro » rend l'en-tête sans complétion ni chiffre : il doit tenir debout avec un
    // titre générique, et surtout ne pas faire tomber la page.
    await mockMba(page, { account: { hasNumber: false, phoneNumberId: null, verifiedName: null, number: null } });
    await page.goto('/mba/parametres');
    await expect(page.getByTestId('mba-gate-no-number')).toBeVisible();
    await expect(page.getByTestId('entete-agent')).toContainText('Paramètres de l’agent');
    await expect(page.getByTestId('entete-agent-messages')).toHaveCount(0);
    await expect(page.getByTestId('entete-agent-ratio')).toHaveCount(0);
    // 🔴 ET SURTOUT PAS « Tout est réglé » : la complétion n'a jamais été lue, rien n'a été mesuré. Une
    // liste d'étapes vide ferait dire à l'en-tête le contraire du bandeau qui est juste en dessous.
    await expect(page.getByTestId('entete-agent-etapes')).toHaveCount(0);
  });
});
