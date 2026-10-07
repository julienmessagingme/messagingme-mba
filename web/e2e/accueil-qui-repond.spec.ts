import { test, expect } from '@playwright/test';
import { mockAccueil } from './support/accueil';
import { repondre } from './aide/confirmation';

/**
 * « QUI RÉPOND AU CLIENT » SUR L'ACCUEIL (RC6, plan `docs/superpowers/plans/2026-10-06-rc6-qui-repond.md`, livraison B).
 *
 * Ce qu'on vérifie vraiment : les quatre positions ; une position qui ne peut pas répondre est GRISÉE avec le lien qui
 * la configure ; rien ne part à la sélection, il faut « Enregistrer » ; le corps envoyé (l'agent, le scénario et son
 * délai en heures) ; quitter « MBA » se confirme et un refus n'envoie rien ; un mode dont la cible a disparu est DIT ;
 * et une API d'avant RC6 (la route rend `{}`) ne fait pas apparaître de carte qui mentirait.
 */
const ETAT = {
  mode: 'equipe', modeEffectif: 'equipe', agentId: null, workflowId: null, delaiS: 86400,
  mbaAllume: false, mbaConfigurable: true, modeleDisponible: true,
  agentsActifs: [{ id: 'ag-lea', label: 'Léa' }, { id: 'ag-marc', label: 'Marc' }],
  scenariosPublies: [{ id: 'wf-1', name: 'Bienvenue' }, { id: 'wf-2', name: 'Devis' }],
};

test.describe('Accueil : qui répond au client', () => {
  test('🔴 les quatre positions ; la sélection seule n’envoie rien ; « Enregistrer » envoie l’agent choisi', async ({ page }) => {
    const reglages: unknown[] = [];
    await mockAccueil(page, { quiRepond: ETAT, reglagesRepondeur: reglages });
    const carte = page.getByTestId('qui-repond');
    for (const nom of ['L’agent de Meta (MBA)', 'Un agent IA', 'Un scénario', 'L’équipe']) {
      await expect(carte.getByRole('radio', { name: nom })).toBeEnabled();
    }
    await expect(carte.getByRole('radio', { name: 'L’équipe' })).toBeChecked();
    const enregistrer = page.getByTestId('qui-repond-enregistrer');
    await expect(enregistrer).toBeDisabled();
    await carte.getByRole('radio', { name: 'Un agent IA' }).check();
    await page.getByTestId('qui-repond-agent').selectOption('ag-marc');
    expect(reglages).toEqual([]);
    await enregistrer.click();
    await expect.poll(() => reglages).toEqual([{ mode: 'agent', agentId: 'ag-marc' }]);
    // Relu : la carte dit ce qui est en vigueur, et le bouton se rendort.
    await expect(carte.getByRole('radio', { name: 'Un agent IA' })).toBeChecked();
    await expect(enregistrer).toBeDisabled();
  });

  test('🔴 un scénario publié et son délai EN HEURES ; un délai hors bornes bloque l’enregistrement', async ({ page }) => {
    const reglages: unknown[] = [];
    await mockAccueil(page, { quiRepond: ETAT, reglagesRepondeur: reglages });
    const carte = page.getByTestId('qui-repond');
    await carte.getByRole('radio', { name: 'Un scénario' }).check();
    await page.getByTestId('qui-repond-scenario').selectOption('wf-2');
    const delai = page.getByTestId('qui-repond-delai');
    await expect(delai).toHaveValue('24');
    await delai.fill('0');
    await expect(page.getByTestId('qui-repond-delai-invalide')).toBeVisible();
    await expect(page.getByTestId('qui-repond-enregistrer')).toBeDisabled();
    await delai.fill('48');
    await page.getByTestId('qui-repond-enregistrer').click();
    await expect.poll(() => reglages).toEqual([{ mode: 'scenario', workflowId: 'wf-2', delaiHeures: 48 }]);
  });

  test('🔴 une position qui ne peut pas répondre est GRISÉE, avec le lien qui la configure', async ({ page }) => {
    await mockAccueil(page, { quiRepond: { ...ETAT, mbaConfigurable: false, agentsActifs: [], scenariosPublies: [] } });
    const carte = page.getByTestId('qui-repond');
    await expect(carte.getByRole('radio', { name: 'L’agent de Meta (MBA)' })).toBeDisabled();
    await expect(carte.getByRole('radio', { name: 'Un agent IA' })).toBeDisabled();
    await expect(carte.getByRole('radio', { name: 'Un scénario' })).toBeDisabled();
    await expect(carte.getByRole('radio', { name: 'L’équipe' })).toBeEnabled();
    await expect(page.getByTestId('qui-repond-mba-grisee').getByRole('link')).toHaveAttribute('href', '/mba/parametres');
    await expect(page.getByTestId('qui-repond-agent-grisee').getByRole('link')).toHaveAttribute('href', '/agents');
    await expect(page.getByTestId('qui-repond-scenario-grisee').getByRole('link')).toHaveAttribute('href', '/workflows');
  });

  test('🔴 quitter « MBA » se confirme : un refus n’envoie rien, l’accord envoie l’équipe', async ({ page }) => {
    const reglages: unknown[] = [];
    await mockAccueil(page, {
      settings: { controlHandbackSeconds: null, mbaEnabled: true, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false },
      quiRepond: { ...ETAT, mode: 'mba', modeEffectif: 'mba', mbaAllume: true },
      reglagesRepondeur: reglages,
    });
    const carte = page.getByTestId('qui-repond');
    await carte.getByRole('radio', { name: 'L’équipe' }).check();
    await page.getByTestId('qui-repond-enregistrer').click();
    await repondre(page, false, /L’agent de Meta cessera de répondre aux conversations qu’il tient/);
    expect(reglages).toEqual([]);
    await page.getByTestId('qui-repond-enregistrer').click();
    await repondre(page, true, /cessera de répondre/);
    await expect.poll(() => reglages).toEqual([{ mode: 'equipe' }]);
  });

  test('🔴 choisir « MBA » allume l’agent de Meta : l’interrupteur de sa carte suit', async ({ page }) => {
    await mockAccueil(page, { quiRepond: ETAT });
    await expect(page.getByTestId('mba-toggle')).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('qui-repond').getByRole('radio', { name: 'L’agent de Meta (MBA)' }).check();
    await page.getByTestId('qui-repond-enregistrer').click();
    await expect(page.getByTestId('mba-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  test('🔴 un mode dont la cible a disparu se lit « Équipe », et la carte le DIT', async ({ page }) => {
    await mockAccueil(page, { quiRepond: { ...ETAT, mode: 'agent', modeEffectif: 'equipe', agentId: null } });
    await expect(page.getByTestId('qui-repond-cible-disparue'))
      .toHaveText('L’agent IA choisi a été désactivé ou supprimé : vos messages vont à l’équipe.');
    await expect(page.getByTestId('qui-repond').getByRole('radio', { name: 'L’équipe' })).toBeChecked();
  });

  test('une API d’avant RC6 (la route rend `{}`) : aucune carte, plutôt qu’un réglage qu’on n’a pas lu', async ({ page }) => {
    await mockAccueil(page);
    // Ancre positive : la page est chargée (la carte de l'agent de Meta est là).
    await expect(page.getByTestId('settings-card')).toBeVisible();
    await expect(page.getByTestId('qui-repond')).toHaveCount(0);
  });
});
