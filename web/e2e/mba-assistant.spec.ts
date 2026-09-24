import { test, expect } from '@playwright/test';
import { mockMba } from './support/mba';

/**
 * L'ONGLET ASSISTANT DE L'AGENT DE META : ce qu'il a l'air d'être, et ce qu'il ne propose plus.
 *
 * 🔴 CE FICHIER NAÎT PARCE QUE CE PANNEAU N'AVAIT AUCUN TEST D'INTERFACE (2026-09-24). Deux tests serveur
 * couvraient sa route et son dépôt de pièce jointe, zéro couvrait l'écran. C'est le même défaut que la page
 * du guide, trouvé le même jour : un écran sans témoin est un écran dont on ne sait pas ce qu'il montre.
 *
 * ⚠️ IL ÉPINGLE DES COMPORTEMENTS, PAS DES CLASSES CSS. Julien a demandé que ça « ressemble vraiment à un
 * bot » : le cadre, le fond et les queues de bulles servent ça mais ne se testent pas utilement, un test qui
 * lit une classe Tailwind interdit de la changer sans rien garantir de ce que voit le lecteur. Ce qui se
 * teste, c'est ce qui CHANGE pour l'utilisateur : le bouton retiré, le champ devenu multiligne, les exemples
 * qui remplissent sans envoyer, et l'état lu sur la vraie complétion.
 */
test.describe('MBA Assistant : ce que l ecran propose', () => {
  test('🔴 le bouton « Joindre » a disparu, et la saisie est toujours la', async ({ page }) => {
    // Demande de Julien du 2026-09-24 : « tu dégages le bouton joindre qui est à gauche de la fenêtre de
    // conversation ». Aucune capacité perdue : l'onglet Fichiers dépose un document par sa propre route.
    await mockMba(page);
    await page.goto('/mba/parametres?tab=assistant');

    // 🔴 L'ANCRE POSITIVE D'ABORD : une négation seule passerait sur un panneau qui ne s'est pas rendu.
    await expect(page.getByTestId('mba-assistant-saisie')).toBeVisible();
    await expect(page.getByTestId('mba-assistant-joindre')).toHaveCount(0);
    await expect(page.getByTestId('mba-assistant-fichier')).toHaveCount(0);
  });

  test('🔴 la saisie est un textarea, pas un input : Maj+Entree servait a rien avant', async ({ page }) => {
    /**
     * Le composant gérait DÉJÀ Maj+Entrée pour aller à la ligne, mais un `input` HTML ne peut pas afficher
     * deux lignes : la fonction existait et son effet était invisible. C'est une capacité qui était offerte
     * et inerte, le motif que ce produit s'interdit ailleurs.
     */
    await mockMba(page);
    await page.goto('/mba/parametres?tab=assistant');
    const champ = page.getByTestId('mba-assistant-saisie');
    await expect(champ).toBeVisible();
    expect(await champ.evaluate((el) => el.tagName)).toBe('TEXTAREA');

    // Et la promesse du placeholder est tenue : deux lignes s'affichent vraiment.
    await champ.fill('première ligne\nseconde ligne');
    await expect(champ).toHaveValue('première ligne\nseconde ligne');
  });

  test('🔴 un exemple REMPLIT le champ, il n envoie pas', async ({ page }) => {
    /**
     * 🔴 LA DISTINCTION EST LE SUJET DU CAS. Un exemple qui envoie tout seul dépense un tour de modèle sur
     * une phrase que personne n'a relue, et sur cet écran un tour finit par un diff qui touche la
     * configuration réelle chez Meta. Il remplit, on relit, on modifie, puis on envoie.
     */
    const appels = await mockMba(page);
    await page.goto('/mba/parametres?tab=assistant');

    const exemples = page.getByTestId('mba-assistant-exemples').getByRole('button');
    await expect(exemples.first()).toBeVisible();
    const texte = (await exemples.first().textContent())?.trim() ?? '';
    expect(texte, 'le premier exemple est vide').not.toBe('');
    await exemples.first().click();

    await expect(page.getByTestId('mba-assistant-saisie')).toHaveValue(texte);
    // Aucun POST vers l'assistant : le clic n'a rien envoyé au modèle.
    expect(appels.some((a) => a.method === 'POST' && a.url.includes('/mba/assistant')),
      'un exemple cliqué a envoyé la question au modèle').toBe(false);
  });

  test('🔴 l etat lit la VRAIE completion, il ne l invente pas', async ({ page }) => {
    /**
     * L'assistant d'un agent IA affiche « Entretien : X points sur Y » parce qu'il MÈNE un entretien en neuf
     * points. Celui-ci n'en mène aucun : son chiffre est celui de la complétion, le même que l'en-tête de
     * l'écran affiche. Deux sources auraient fini par se contredire sur le même écran.
     *
     * La fixture pose UNE tâche `a_faire` (la FAQ) : l'assistant doit donc annoncer une étape, et l'en-tête
     * la même. C'est la concordance qu'on tient ici, pas le libellé.
     */
    await mockMba(page);
    await page.goto('/mba/parametres?tab=assistant');
    await expect(page.getByTestId('mba-assistant-etat')).toContainText('1 étape');
    await expect(page.getByTestId('entete-agent-etapes')).toContainText('1 étape à finir');
  });

  test('🔴 une etape FACULTATIVE a faire ne se dit jamais « obligatoire »', async ({ page }) => {
    /**
     * 🔴 LE CAS QUI A LAISSE PASSER UN LIBELLE FAUX, trouve par une relecture a froid le 2026-09-24. Le
     * compte affiche est celui de l'en-tete, donc il inclut les etapes FACULTATIVES restant a faire
     * (`fichiers` et `sites` sont `requise: false` dans `src/mba/completion.ts`). La ligne d'etat disait
     * « il reste N etape(s) OBLIGATOIRE(S) » : un espace dont tout l'obligatoire est regle, sans fichier de
     * connaissance ni site declare, lisait « il reste 2 etapes obligatoires » alors qu'il n'en restait zero.
     *
     * ⚠️ LE CORRECTIF N'A PAS ETE DE FILTRER SUR `requise`, ET CE TEST TIENT LES DEUX MOITIES. Filtrer aurait
     * fait diverger ce chiffre de celui de l'en-tete, donc deux comptes differents sur le meme ecran : pire
     * que le mot faux. On tient donc a la fois que le mot a disparu ET que les deux chiffres concordent.
     *
     * La completion posee ici est le cas exact : tout l'obligatoire fait, deux FACULTATIVES a faire.
     */
    await mockMba(page, {
      completion: {
        taches: [
          { cle: 'business_info', requise: true, etat: 'faite' },
          { cle: 'faq', requise: true, etat: 'faite' },
          { cle: 'competences', requise: true, etat: 'faite' },
          { cle: 'activation', requise: true, etat: 'faite' },
          { cle: 'fichiers', requise: false, etat: 'a_faire', raison: 'Aucun fichier de connaissance.' },
          { cle: 'sites', requise: false, etat: 'a_faire', raison: 'Aucun site déclaré.' },
        ],
        faites: 4, total: 4, indeterminees: 0,
      },
    });
    await page.goto('/mba/parametres?tab=assistant');

    const etat = page.getByTestId('mba-assistant-etat');
    // L'ancre positive : le compte est bien celui de l'en-tete, deux etapes.
    await expect(etat).toContainText('2 étape');
    await expect(page.getByTestId('entete-agent-etapes')).toContainText('2 étapes à finir');
    // Et le mot faux ne revient pas, dans aucune des deux langues.
    await expect(etat, 'la ligne d etat qualifie de nouveau des facultatives d obligatoires')
      .not.toContainText(/obligatoire|required/i);
  });
});
