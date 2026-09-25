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
   *
   * ⚠️ LA PHRASE « L'agent de Meta RÉPOND en ce moment, à tout le monde. Il répond avant nos scénarios. » EST
   * PARTIE (Julien, 2026-09-25 : on retire, on n'ajoute rien). Ce qui reste vrai se vérifie : l'interrupteur dit
   * notre état, le chiffre de l'agent est là, et aucune phrase ne prétend le contraire.
   */
  test('🔴 l’agent de Meta répond à tout le monde : l’interrupteur et le chiffre, sans la phrase', async ({ page }) => {
    await mockAccueil(page, {
      settings: { controlHandbackSeconds: null, mbaEnabled: true, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false },
      mbaStatus: { phoneNumberId: 'PN1', eligible: true, onboarded: true, agentId: 'ag1', settings: { rollout: { enabled: true }, ai_audience: 'EVERYONE' } },
      mbaMessages: { messages: 1412 },
    });
    const carte = page.getByTestId('settings-card');
    await expect(page.getByTestId('mba-toggle')).toHaveAttribute('aria-pressed', 'true');
    // Ancre positive : le chiffre n'est lu QUE si Meta dit que l'agent répond, donc le statut a bien été lu.
    await expect(carte.getByTestId('mba-messages')).toContainText('1 412');
    await expect(carte).not.toContainText(/RÉPOND en ce moment|IS ANSWERING right now/);
    await expect(carte).not.toContainText(/Il répond avant nos scénarios|It answers before our scenarios/);
    await expect(page.getByTestId('mba-etat-reel')).toHaveCount(0);
    // Et la phrase écrite en dur ne réapparaît PAS quand Meta a ouvert le numéro.
    await expect(carte).not.toContainText(/En attente d’ouverture Meta|Awaiting Meta rollout/);
  });

  test('🔴 « en attente d’ouverture Meta » ne s’affiche QUE si Meta le dit', async ({ page }) => {
    await mockAccueil(page, { mbaStatus: { phoneNumberId: 'PN1', eligible: false, onboarded: false, agentId: null, settings: null } });
    const etat = page.getByTestId('mba-etat-reel');
    await expect(etat).toContainText(/n'a pas encore ouvert|has not opened/);
    // Et le bouton DIT qu'il ne pilote que notre côté, ce que son silence laissait croire l'inverse.
    await expect(page.getByTestId('settings-card')).toContainText(/côté Engage Me seulement|Engage Me side only/);
  });

  test('agent qui répond à la liste autorisée : aucune phrase d’état (décision du 2026-09-25)', async ({ page }) => {
    await mockAccueil(page, {
      mbaStatus: { phoneNumberId: 'PN1', eligible: true, onboarded: true, agentId: 'ag1', settings: { rollout: { enabled: true }, ai_audience: 'ALLOWLISTED_ONLY' } },
    });
    await expect(page.getByTestId('mba-toggle')).toBeVisible();
    await expect(page.getByTestId('mba-etat-reel')).toHaveCount(0);
  });

  test('le toggle MBA reflète CE QUE LE SERVEUR A FAIT, plus une bascule optimiste', async ({ page }) => {
    // 🔴 IL BASCULAIT DE FAÇON OPTIMISTE, ET C'EST CE QUI A COÛTÉ TROIS PANNES LE 2026-09-10 : il affichait
    // le nouvel état AVANT de savoir, et le chemin qui devait appeler Meta était sauté en silence quand un
    // état côté navigateur n'était pas encore chargé. L'écran annonçait « désactivé » pendant que l'agent
    // de Meta répondait aux clients. Il attend désormais la réponse de la route unique d'activation.
    await mockAccueil(page);
    const toggle = page.getByTestId('mba-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  test('🔴 un refus du serveur ne bascule RIEN, et il le DIT', async ({ page }) => {
    // Le cas qui n'existait pas et qui est toute la raison du lot : quand l'état chez Meta n'a pas pu être
    // lu, le serveur n'écrit RIEN, ni chez Meta ni chez nous, et répond 409. Le bouton doit rester sur son
    // état d'avant, qui est le vrai, au lieu d'afficher un changement qui n'a pas eu lieu.
    await mockAccueil(page, { activationRefusee: 'L’état de l’agent chez Meta n’a pas pu être lu.' });
    const toggle = page.getByTestId('mba-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(page.getByTestId('mba-erreur')).toContainText(/pas pu être lu/);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });
});

/**
 * LE CHIFFRE DANS LE CADRE DE L'AGENT DE META (Julien, 2026-09-25) : les messages qu'il a ÉCRITS, depuis
 * toujours, la MÊME mesure et le MÊME libellé que l'en-tête de MBA > Paramètres
 * (`web/e2e/mba-parametres-entete.spec.ts`). Un nombre et son libellé, aucune légende.
 */
test.describe('Accueil : les messages écrits par l’agent de Meta', () => {
  const REPOND = { phoneNumberId: 'PN1', eligible: true, onboarded: true, agentId: 'ag1', settings: { rollout: { enabled: true }, ai_audience: 'EVERYONE' } };

  test('l’agent RÉPOND chez Meta : le chiffre DANS le cadre, avec son seul libellé', async ({ page }) => {
    await mockAccueil(page, { mbaStatus: REPOND, mbaMessages: { messages: 1412 } });
    // DANS le cadre, plus dessous.
    const chiffre = page.getByTestId('settings-card').getByTestId('mba-messages');
    await expect(chiffre).toContainText('1 412');
    await expect(chiffre).toContainText('Messages écrits par le MBA');
    // Aucune légende : ni l'aveu du fil entier, ni une fenêtre (le compte est un total).
    await expect(chiffre).not.toContainText(/y compris|conversations|jours|days/);
    await expect(page.getByTestId('mba-messages')).toHaveCount(1);
  });

  test('🔴 agent éteint chez Meta, même avec NOTRE drapeau allumé : aucune lecture, aucun chiffre', async ({ page }) => {
    const lectures: string[] = [];
    await mockAccueil(page, {
      settings: { controlHandbackSeconds: null, mbaEnabled: true, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false },
      mbaMessages: { messages: 1412 },
      lecturesChiffres: lectures,
    });
    // Ancre positive : le statut de Meta est lu (éligible, éteint), et notre drapeau est bien allumé.
    await expect(page.getByTestId('mba-etat-reel')).toContainText(/agent éteint chez Meta|agent off at Meta/);
    await expect(page.getByTestId('mba-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('mba-messages')).toHaveCount(0);
    expect(lectures.filter((l) => l.endsWith('/messages'))).toEqual([]);
  });

  test('🔴 route absente, ou `messages: null` : pas de chiffre, jamais un zéro', async ({ page }) => {
    for (const mbaMessages of ['absent', { messages: null }]) {
      const lectures: string[] = [];
      await mockAccueil(page, { mbaStatus: REPOND, mbaMessages, lecturesChiffres: lectures });
      await expect(page.getByTestId('settings-card')).toBeVisible();
      // Ancre positive : la lecture n'est lancée QUE si Meta dit que l'agent répond, donc son statut a été lu.
      await expect.poll(() => lectures).toContain('GET /tenants/t-e2e/mba/PN1/messages');
      await expect(page.getByTestId('mba-messages'), JSON.stringify(mbaMessages)).toHaveCount(0);
    }
  });
});
