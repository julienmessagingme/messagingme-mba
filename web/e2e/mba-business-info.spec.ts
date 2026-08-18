import { test, expect } from '@playwright/test';
import { mockMba, appelsMba } from './support/mba';

const EXISTANT = {
  business_description: 'Réseau de bus d’Auxerre',
  return_policy: 'Aucun remboursement après validation.',
  contact_info: { email: 'contact@bus.fr', address: 'Auxerre' },
};

test.describe('MBA Paramètres : informations business', () => {
  test('🔴 n’envoie QUE les champs modifiés', async ({ page }) => {
    // La ressource est en remplacement complet côté Meta. Poster le formulaire entier réécrirait des champs
    // que personne n'a touchés, avec la valeur qu'ils avaient au chargement de la page.
    const calls = await mockMba(page, { businessInfo: EXISTANT });
    await page.goto('/mba/parametres?tab=business');

    await expect(page.getByTestId('mba-bi-description')).toHaveValue('Réseau de bus d’Auxerre');
    await page.getByTestId('mba-bi-paymentMethod').fill('Carte, espèces, application');
    await page.getByTestId('mba-bi-save').click();

    await expect.poll(() => appelsMba(calls, 'PATCH', '/business-info')[0]?.body)
      .toEqual({ paymentMethod: 'Carte, espèces, application' });
  });

  test('un champ de contact modifié n’emporte que lui', async ({ page }) => {
    const calls = await mockMba(page, { businessInfo: EXISTANT });
    await page.goto('/mba/parametres?tab=business');
    await page.getByTestId('mba-bi-hours_of_operation').fill('Du lundi au samedi, 6h à 21h');
    await page.getByTestId('mba-bi-save').click();
    await expect.poll(() => appelsMba(calls, 'PATCH', '/business-info')[0]?.body)
      .toEqual({ contact: { hours_of_operation: 'Du lundi au samedi, 6h à 21h' } });
  });

  test('🔴 ce qui est tapé PENDANT l’enregistrement n’est pas effacé par la réponse', async ({ page }) => {
    // Rien n'empêche visuellement de continuer à écrire pendant que la requête est en vol. Si l'écran se
    // repeuple depuis la réponse, la saisie en cours disparaît sous un bandeau vert « Informations
    // enregistrées » : l'utilisateur croit son texte sauvé alors qu'il vient d'être jeté.
    const calls = await mockMba(page, {
      businessInfo: EXISTANT,
      custom: async (route, method, url, body) => {
        if (method === 'PATCH' && url.includes('/business-info')) {
          await new Promise((r) => setTimeout(r, 900));
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...EXISTANT, payment_method: (body ?? {}).paymentMethod }) });
          return true;
        }
        return false;
      },
    });
    await page.goto('/mba/parametres?tab=business');

    await page.getByTestId('mba-bi-paymentMethod').fill('Carte et espèces');
    await page.getByTestId('mba-bi-save').click();
    await page.getByTestId('mba-bi-returnPolicy').fill('Remboursement sous 14 jours.');

    await expect(page.getByTestId('mba-bi-saved')).toBeVisible();
    await expect(page.getByTestId('mba-bi-returnPolicy')).toHaveValue('Remboursement sous 14 jours.');
    // Et ce qui a été tapé pendant l'appel reste enregistrable : le bouton n'annonce pas « rien à faire ».
    await expect(page.getByTestId('mba-bi-save')).toBeEnabled();
    await page.getByTestId('mba-bi-save').click();
    await expect.poll(() => appelsMba(calls, 'PATCH', '/business-info').at(-1)?.body)
      .toEqual({ returnPolicy: 'Remboursement sous 14 jours.' });
  });

  test('rien de modifié : le bouton reste inactif', async ({ page }) => {
    const calls = await mockMba(page, { businessInfo: EXISTANT });
    await page.goto('/mba/parametres?tab=business');
    await expect(page.getByTestId('mba-bi-save')).toBeDisabled();
    expect(appelsMba(calls, 'PATCH', '/business-info')).toHaveLength(0);
  });
});
