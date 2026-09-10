import { test, expect } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * F1 : la carte Meta Business Agent est remontée en tête. La reprise après opérateur, elle, a quitté cet
 * écran pour MBA > Paramètres > Activation, où elle vit avec le passage de main.
 */
test.describe('Accueil : carte MBA + reprise opérateur (F1)', () => {
  test('la carte MBA est AVANT la carte Numéro dans le DOM', async ({ page }) => {
    await mockAccueil(page);
    await expect(page.getByTestId('settings-card')).toBeVisible();
    await expect(page.getByTestId('numero-card')).toBeVisible();
    const order = await page.$$eval('[data-testid]', (els) =>
      els
        .map((e) => e.getAttribute('data-testid'))
        .filter((id): id is string => id === 'settings-card' || id === 'numero-card'),
    );
    expect(order).toEqual(['settings-card', 'numero-card']);
  });

  test('la reprise après opérateur ne se règle plus ICI : l’accueil renvoie vers l’écran Activation', async ({ page }) => {
    await mockAccueil(page);
    await expect(page.getByTestId('handback-input')).toHaveCount(0);
    const lien = page.locator('[data-testid="settings-card"] [data-testid="lien-activation"]');
    await expect(lien).toBeVisible();
    await expect(lien).toHaveAttribute('href', '/mba/parametres?tab=activation');
  });

  /**
   * 🔴 LA CARTE NE DOIT PLUS MENTIR, ET C'EST TOUT L'OBJET DE CE BLOC. Le 2026-09-10, elle affichait NOTRE
   * drapeau local sous le titre « Meta Business Agent », à côté d'une phrase ÉCRITE EN DUR annonçant qu'on
   * attendait l'ouverture de Meta. Les deux étaient faux le même jour : l'agent de Meta répondait à tout le
   * monde depuis des jours, et Julien a baissé ce bouton en croyant l'éteindre. Il a éteint notre drapeau,
   * qui ne commande que le bloc MBA du constructeur de scénario.
   */
  test('🔴 la carte dit que l’agent de Meta RÉPOND quand il répond', async ({ page }) => {
    await mockAccueil(page, {
      mbaStatus: { phoneNumberId: 'PN1', eligible: true, onboarded: true, agentId: 'ag1', settings: { rollout: { enabled: true }, ai_audience: 'EVERYONE' } },
    });
    const etat = page.getByTestId('mba-etat-reel');
    await expect(etat).toContainText(/RÉPOND en ce moment|IS ANSWERING right now/);
    await expect(etat).toContainText(/tout le monde|everyone/);
    // Et la phrase écrite en dur ne réapparaît PAS quand Meta a ouvert le numéro.
    await expect(etat).not.toContainText(/En attente d’ouverture Meta|Awaiting Meta rollout/);
  });

  test('🔴 « en attente d’ouverture Meta » ne s’affiche QUE si Meta le dit', async ({ page }) => {
    await mockAccueil(page, { mbaStatus: { phoneNumberId: 'PN1', eligible: false, onboarded: false, agentId: null, settings: null } });
    const etat = page.getByTestId('mba-etat-reel');
    await expect(etat).toContainText(/n'a pas encore ouvert|has not opened/);
    // Et le bouton DIT qu'il ne pilote que notre côté, ce que son silence laissait croire l'inverse.
    await expect(page.getByTestId('settings-card')).toContainText(/côté Engage Me seulement|Engage Me side only/);
  });

  test('l’audience restreinte est nommée, parce qu’elle change qui peut tomber sur l’agent', async ({ page }) => {
    await mockAccueil(page, {
      mbaStatus: { phoneNumberId: 'PN1', eligible: true, onboarded: true, agentId: 'ag1', settings: { rollout: { enabled: true }, ai_audience: 'ALLOWLISTED_ONLY' } },
    });
    await expect(page.getByTestId('mba-etat-reel')).toContainText(/liste autorisée|allowlist/);
  });

  test('le toggle MBA bascule (optimiste) au clic', async ({ page }) => {
    await mockAccueil(page);
    const toggle = page.getByTestId('mba-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });
});
