import { test, expect, type Page } from '@playwright/test';

/**
 * L'écran Automation et la dernière analyse (lot 3 de « Tout sur la fiche ») : le déclencheur « un champ
 * d'analyse devient », les filtres de « conversation analysée », et le délai de relance réglable à l'écran.
 *
 * 🔴 CE QUE CES CAS PROTÈGENT : ce qui PART au serveur. Un écran qui montre « sentiment devient négatif » et poste
 * une config vide créerait une automation qui ne part jamais, ou partirait à chaque analyse.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const WF = { id: 'wf1', name: 'Rappel mécontent', graph: { nodes: [], edges: [] } };

const CHAMPS_FICHE = {
  champs: [
    { cle: 'nom', libelle: ['nom du contact', 'contact’s name'], provenance: 'base', type: { nature: 'texte' }, operateurs: [] },
    { cle: 'analyse_sentiment', libelle: ['sentiment de la dernière analyse', 'latest analysis sentiment'], provenance: 'analyse', type: { nature: 'choix', valeurs: ['positif', 'neutre', 'negatif'] }, operateurs: ['in', 'empty', 'not_empty'] },
    { cle: 'analyse_urgence', libelle: ['urgence de la dernière analyse (0 à 10)', 'latest analysis urgency (0 to 10)'], provenance: 'analyse', type: { nature: 'note' }, operateurs: ['gte', 'lte', 'empty', 'not_empty'] },
    { cle: 'analyse_le', libelle: ['date de la dernière analyse', 'latest analysis date'], provenance: 'analyse', type: { nature: 'date' }, operateurs: ['newer_than_days', 'empty', 'not_empty'] },
  ],
};

async function monter(page: Page, o: { posted: Array<Record<string, unknown>>; champsFiche?: 'ok' | 404 }): Promise<void> {
  let listed: Array<Record<string, unknown>> = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.endsWith('/champs-fiche')) return o.champsFiche === 404 ? json({ error: 'not found' }, 404) : json(CHAMPS_FICHE);
    if (url.endsWith('/automations') && req.method() === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>;
      o.posted.push(body);
      listed = [{ id: 'a1', ...body, conditionGroup: null, startNodeId: null, cooldownSeconds: body.cooldownSeconds ?? null }];
      return json({ id: 'a1' }, 201);
    }
    if (url.endsWith('/automations')) return json({ automations: listed });
    if (url.endsWith('/workflows')) return json({ workflows: [WF] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/automations');
  await page.getByTestId('automation-add').click();
  await page.getByTestId('automation-name').fill('Mécontents');
}

test.describe('Automation : la dernière analyse', () => {
  test('🔴 « le sentiment devient négatif » part avec son filtre et le délai choisi, et se relit en clair', async ({ page }) => {
    const posted: Array<Record<string, unknown>> = [];
    await monter(page, { posted });
    await page.getByTestId('automation-trigger').selectOption('analyse_devient');
    const bloc = page.getByTestId('config-analyse-devient');
    // La date d'analyse ne « devient » rien : elle n'est pas proposée.
    await expect(bloc.getByTestId('filtre-analyse-champ').locator('option')).toHaveText([
      'sentiment de la dernière analyse', 'urgence de la dernière analyse (0 à 10)',
    ]);
    // Les opérateurs « vide » et « renseigné » ne décrivent pas un changement : seul « est l'un de » reste.
    await expect(bloc.getByTestId('filtre-analyse-operateur').locator('option')).toHaveCount(1);
    await bloc.getByRole('button', { name: 'Négatif' }).click();
    await bloc.getByRole('button', { name: 'Positif' }).click();
    await expect(page.getByTestId('automation-anti-rebond').locator('option').first()).toHaveText(/7 jours/);
    await page.getByTestId('automation-anti-rebond').selectOption(String(3 * 24 * 3600));
    await page.getByTestId('automation-workflow').selectOption('wf1');
    await page.getByTestId('automation-submit').click();
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toMatchObject({
      triggerKind: 'analyse_devient',
      triggerConfig: { cle: 'analyse_sentiment', op: 'in', valeur: 'negatif' },
      cooldownSeconds: 3 * 24 * 3600,
      enabled: false,
    });
    await expect(page.getByText('la dernière analyse devient : sentiment de la dernière analyse est l’un de Négatif')).toBeVisible();
  });

  test('« l’urgence passe à 7 ou plus » : le seuil part tel quel, sans délai réglé', async ({ page }) => {
    const posted: Array<Record<string, unknown>> = [];
    await monter(page, { posted });
    await page.getByTestId('automation-trigger').selectOption('analyse_devient');
    const bloc = page.getByTestId('config-analyse-devient');
    await bloc.getByTestId('filtre-analyse-champ').selectOption('analyse_urgence');
    await expect(bloc.getByTestId('filtre-analyse-operateur')).toHaveValue('gte');
    await bloc.getByTestId('filtre-analyse-note').fill('7');
    await page.getByTestId('automation-workflow').selectOption('wf1');
    await page.getByTestId('automation-submit').click();
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toMatchObject({ triggerKind: 'analyse_devient', triggerConfig: { cle: 'analyse_urgence', op: 'gte', valeur: '7' } });
    // Aucun délai choisi : le défaut du serveur s'applique, rien n'est envoyé.
    expect(posted[0]).not.toHaveProperty('cooldownSeconds');
  });

  test('🔴 « conversation analysée » envoie ses filtres sur l’analyse en plus du ressenti', async ({ page }) => {
    const posted: Array<Record<string, unknown>> = [];
    await monter(page, { posted });
    await page.getByTestId('automation-trigger').selectOption('conversation_analyzed');
    await page.getByTestId('automation-ajouter-filtre-analyse').click();
    const ligne = page.getByTestId('automation-filtre-analyse').first();
    await ligne.getByTestId('filtre-analyse-champ').selectOption('analyse_urgence');
    await ligne.getByTestId('filtre-analyse-note').fill('8');
    await page.getByTestId('automation-workflow').selectOption('wf1');
    await page.getByTestId('automation-submit').click();
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toMatchObject({
      triggerKind: 'conversation_analyzed',
      triggerConfig: { sentiment: 'negatif', filtres: [{ cle: 'analyse_urgence', op: 'gte', valeur: '8' }] },
    });
  });

  test('🔴 une API qui ne décrit pas les champs (404) ne propose pas le déclencheur', async ({ page }) => {
    await monter(page, { posted: [], champsFiche: 404 });
    await expect(page.getByTestId('automation-trigger').locator('option[value="risque_eleve"]')).toHaveCount(1);
    await expect(page.getByTestId('automation-trigger').locator('option[value="analyse_devient"]')).toHaveCount(0);
  });
});
