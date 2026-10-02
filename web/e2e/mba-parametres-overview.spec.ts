import { test, expect } from '@playwright/test';
import { mockMba, appelsMba } from './support/mba';
import { repondre } from './aide/confirmation';

/**
 * Vue d'ensemble : l'allumage de l'agent, les interdits de langage. L'audience ne se choisit plus : l'agent ne
 * répond qu'aux contacts de sa liste, que la plateforme tient seule.
 *
 * L'allumage est le point sensible de tout l'écran. Meta documente une asymétrie : éteindre arrête l'agent sur
 * TOUTES les conversations, y compris en cours ; rallumer ne reprend que les nouvelles. Un clic par erreur ne
 * se défait donc pas par un second clic, d'où la confirmation obligatoire.
 */
test.describe('MBA Paramètres : vue d’ensemble', () => {
  test('l’allumage DEMANDE confirmation, et n’appelle rien si on refuse', async ({ page }) => {
    const calls = await mockMba(page);
    await page.goto('/mba/parametres');

    await page.getByTestId('mba-rollout-toggle').click();

    // Le message doit ANNONCER l'effet sur les fils en cours, pas juste demander « êtes-vous sûr ».
    await repondre(page, false, 'nouvelles conversations');
    await expect.poll(() => appelsMba(calls, 'PUT', '/rollout').length).toBe(0);
  });

  test('confirmé : PUT rollout, et l’interrupteur REFLÈTE l’état rendu par le serveur', async ({ page }) => {
    const calls = await mockMba(page);
    await page.goto('/mba/parametres');
    await expect(page.getByTestId('mba-rollout-toggle')).toHaveAttribute('aria-pressed', 'false');

    await page.getByTestId('mba-rollout-toggle').click();
    await repondre(page, true);
    await expect.poll(() => appelsMba(calls, 'PUT', '/rollout')[0]?.body).toEqual({ enabled: true });
    // L'assertion qui compte : sans remontée de la réponse dans l'état, l'appel partirait et l'écran
    // continuerait d'afficher « éteint ». L'opérateur ne saurait pas si son geste a pris.
    await expect(page.getByTestId('mba-rollout-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  test('🔴 un refus de Meta s’affiche tel quel et la page tient debout', async ({ page }) => {
    // Cas réel et actuel : Meta refuse l'allumage tant qu'aucun moyen de paiement n'est enregistré, et son
    // message porte le lien exact à suivre. Le remplacer par « une erreur est survenue » perdrait l'essentiel.
    const message = 'Meta: Cannot enable Meta Business Agent : A payment method is required. Add one in the Billing Hub.';
    await mockMba(page, {
      custom: async (route, method, url) => {
        if (method === 'PUT' && url.includes('/rollout')) {
          await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: message }) });
          return true;
        }
        return false;
      },
    });
    await page.goto('/mba/parametres');
    await page.getByTestId('mba-rollout-toggle').click();
    await repondre(page, true);

    await expect(page.getByTestId('mba-overview-error')).toContainText('payment method');
    // La page reste utilisable : les onglets répondent encore.
    await page.getByTestId('mba-tab-business').click();
    await expect(page.getByTestId('mba-bi-description')).toBeVisible();
  });

  test('les interdits de langage partent en PATCH settings', async ({ page }) => {
    const calls = await mockMba(page);
    await page.goto('/mba/parametres');

    await page.getByTestId('mba-neversay-input').fill('c’est garanti');
    await page.getByTestId('mba-neversay-add').click();
    await expect.poll(() => appelsMba(calls, 'PATCH', '/settings').at(-1)?.body).toEqual({ neverSay: ['c’est garanti'] });
    // La phrase doit APPARAÎTRE : c'est ce qui prouve que la réponse est remontée dans l'état de l'écran.
    await expect(page.getByText('c’est garanti')).toBeVisible();
  });

  test('🔴 l’audience ne se choisit plus, et la liste ne se remplit plus à la main', async ({ page }) => {
    // La plateforme tient la liste de l'agent (elle y met les conversations qu'elle lui confie) : un numéro posé à
    // la main serait ignoré de sa table, et « tout le monde » ferait répondre l'agent par-dessus nos scénarios.
    await mockMba(page);
    await page.goto('/mba/parametres');
    // Ancre positive : la vue d'ensemble est bien affichée. Le paragraphe qui disait à qui l'agent répond est parti
    // (Julien, 2026-10-02 : l'interrupteur seul).
    await expect(page.getByTestId('mba-rollout-toggle')).toBeVisible();
    await expect(page.getByTestId('mba-audience-liste')).toHaveCount(0);
    await expect(page.getByTestId('mba-audience')).toHaveCount(0);
    await expect(page.getByTestId('mba-allowlist-phone')).toHaveCount(0);
    await expect(page.getByTestId('mba-allowlist-list')).toHaveCount(0);
  });

  test('agent pas encore créé chez Meta : ce n’est PAS un blocage général', async ({ page }) => {
    // Seules les compétences exigent un agent_id. Tout le reste doit rester éditable, sinon on rejoue la
    // maquette gelée pour rien.
    await mockMba(page, { status: { onboarded: false, agentId: null, settings: null }, agentId: null });
    await page.goto('/mba/parametres');
    await expect(page.getByTestId('mba-onboarded')).toContainText(/Pas encore|Not yet/);

    await page.getByTestId('mba-tab-business').click();
    await expect(page.getByTestId('mba-bi-description')).toBeEnabled();

    await page.getByTestId('mba-tab-competences').click();
    await expect(page.getByTestId('mba-skills-no-agent')).toBeVisible();
  });
  test('l’allumage est l’interrupteur seul, comme sur l’Accueil : « Activé » ou « Désactivé », sans paragraphe', async ({ page }) => {
    await mockMba(page);
    await page.goto('/mba/parametres');
    await expect(page.getByTestId('mba-rollout-etat')).toHaveText('Désactivé');
    const carte = page.locator('section', { has: page.getByTestId('mba-rollout-toggle') });
    await expect(carte).not.toContainText('rallumer');
    await expect(carte).not.toContainText('confie');
  });

  test('🔴 un identifiant d’agent long reste dans son cadre, sur ordinateur comme sur téléphone', async ({ page }) => {
    const ID = `pfbid0AqhvrSvwxhFg6fLPRJ6sucu7eTfrvRziPbrucahaRayDPYBjYZpGFFAippR6${'x'.repeat(40)}`;
    await mockMba(page, { status: { agentId: ID } });
    for (const largeur of [1280, 375]) {
      await page.setViewportSize({ width: largeur, height: 900 });
      await page.goto('/mba/parametres');
      const id = page.getByText(ID);
      await expect(id).toBeVisible();
      // L'étendue du TEXTE, pas la boîte de l'élément : un texte qui déborde laisse sa boîte dans le cadre (la première
      // version de ce test comparait les boîtes et restait verte sur le défaut).
      const depasse = await id.evaluate((el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        return r.getBoundingClientRect().right - el.closest('section')!.getBoundingClientRect().right;
      });
      expect(depasse, `largeur ${largeur}`).toBeLessThanOrEqual(0);
    }
  });

  test('🔴 « Notre texte » ouvre une zone de rédaction, et rien ne part chez Meta avant « Enregistrer ce texte »', async ({ page }) => {
    const calls = await mockMba(page);
    await page.goto('/mba/parametres');
    await expect(page.getByTestId('mba-passage-texte')).toHaveCount(0);
    await page.getByTestId('mba-passage-CUSTOM').check();
    await expect(page.getByTestId('mba-passage-texte')).toBeVisible();
    await expect(page.getByTestId('mba-passage-a-enregistrer')).toBeVisible();
    expect(appelsMba(calls, 'PATCH', '/settings')).toHaveLength(0);

    const texte = 'Je transmets votre demande à un membre de l’équipe.\nIl vous répond ici même, dans cette conversation.';
    await page.getByTestId('mba-passage-texte').fill(texte);
    await page.getByTestId('mba-passage-enregistrer').click();
    await expect.poll(() => appelsMba(calls, 'PATCH', '/settings')[0]?.body)
      .toEqual({ handoffMessageSelection: 'CUSTOM', handoffMessage: texte });
    await expect(page.getByTestId('mba-passage-enregistre')).toBeVisible();
    await expect(page.getByTestId('mba-passage-CUSTOM')).toBeChecked();
    // Enregistré et inchangé : rien à renvoyer.
    await expect(page.getByTestId('mba-passage-enregistrer')).toBeDisabled();
  });

  test('« Rédigé par l’agent » part tout de suite, sans zone de rédaction', async ({ page }) => {
    const calls = await mockMba(page);
    await page.goto('/mba/parametres');
    // `click` et pas `check` : le choix ne se coche qu'une fois que Meta l'a accepté, pas au clic.
    await page.getByTestId('mba-passage-AGENT').click();
    await expect.poll(() => appelsMba(calls, 'PATCH', '/settings')[0]?.body).toEqual({ handoffMessageSelection: 'AGENT' });
    await expect(page.getByTestId('mba-passage-AGENT')).toBeChecked();
    await expect(page.getByTestId('mba-passage-texte')).toHaveCount(0);
  });

  test('un texte déjà posé chez Meta est relu, coché et affiché en entier', async ({ page }) => {
    const settings = {
      agent_id: 'AG1', channel: 'whatsapp', rollout: { enabled: true }, ai_audience: 'ALLOWLISTED_ONLY', never_say_phrases: [],
      followup: { enabled: false }, handoff: { enabled: true, message: 'Un conseiller vous répond ici.', message_selection: 'CUSTOM' },
    };
    await mockMba(page, { status: { settings } });
    await page.goto('/mba/parametres');
    await expect(page.getByTestId('mba-passage-CUSTOM')).toBeChecked();
    await expect(page.getByTestId('mba-passage-texte')).toHaveValue('Un conseiller vous répond ici.');
    await expect(page.getByTestId('mba-passage-enregistrer')).toBeDisabled();
    await expect(page.getByTestId('mba-passage-inconnu')).toHaveCount(0);
  });
});
