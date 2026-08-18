import { test, expect } from '@playwright/test';
import { mockMba, appelsMba } from './support/mba';

test.describe('MBA Paramètres : compétences', () => {
  test('🔴 le nom est mis en forme pendant la saisie, jamais renvoyé comme une règle à deviner', async ({ page }) => {
    // Meta n'accepte que minuscules, chiffres et tirets. Quelqu'un qui écrit en français normal ne doit pas
    // se prendre un message de format : l'écran met en forme, et ce qu'il produit est toujours accepté.
    const calls = await mockMba(page);
    await page.goto('/mba/parametres?tab=competences');
    await page.getByTestId('mba-skill-new').click();

    // 🔴 FRAPPE réelle, touche par touche. Une mise en forme qui retire le tiret final à chaque frappe avale
    // les séparateurs : « politique de retour » devient « politiquederetour », et c'est ce nom collé qui part.
    await page.getByTestId('mba-skill-title').pressSequentially('Politique de retour');
    await expect(page.getByTestId('mba-skill-title')).toHaveValue('politique-de-retour');
    await expect(page.getByTestId('mba-skill-title-error')).toHaveCount(0);

    await page.getByTestId('mba-skill-description').fill('Quand le client demande un remboursement.');
    await page.getByTestId('mba-skill-body').fill('Rappeler le délai de 14 jours et orienter vers le formulaire.');
    await page.getByTestId('mba-skill-save').click();

    await expect.poll(() => appelsMba(calls, 'POST', '/skills')[0]?.body).toEqual({
      title: 'politique-de-retour',
      description: 'Quand le client demande un remboursement.',
      skill: 'Rappeler le délai de 14 jours et orienter vers le formulaire.',
    });
  });

  test('enregistrement impossible tant qu’un champ manque', async ({ page }) => {
    await mockMba(page);
    await page.goto('/mba/parametres?tab=competences');
    await page.getByTestId('mba-skill-new').click();
    await expect(page.getByTestId('mba-skill-save')).toBeDisabled();
    await page.getByTestId('mba-skill-title').fill('horaires');
    await expect(page.getByTestId('mba-skill-save')).toBeDisabled();
    await page.getByTestId('mba-skill-description').fill('Quand on demande les horaires.');
    await expect(page.getByTestId('mba-skill-save')).toBeDisabled();
    await page.getByTestId('mba-skill-body').fill('Ne jamais inventer un horaire.');
    await expect(page.getByTestId('mba-skill-save')).toBeEnabled();
  });

  test('agent pas encore créé : motif affiché, aucun formulaire', async ({ page }) => {
    await mockMba(page, { agentId: null });
    await page.goto('/mba/parametres?tab=competences');
    await expect(page.getByTestId('mba-skills-no-agent')).toBeVisible();
    await expect(page.getByTestId('mba-skill-new')).toHaveCount(0);
  });

  test('suppression avec confirmation', async ({ page }) => {
    const calls = await mockMba(page, { skills: [{ id: 's1', title: 'ne-pas-inventer', description: 'Toujours.', skill: 'Ne jamais inventer.' }] });
    await page.goto('/mba/parametres?tab=competences');
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: /Supprimer|Delete/ }).first().click();
    await expect.poll(() => appelsMba(calls, 'DELETE', '/skills/s1').length).toBe(1);
  });
});
