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
    // 🔴 Un seul clic sur « Négatif » suffit : la valeur cochée d'office est remplacée, pas complétée.
    await bloc.getByRole('button', { name: 'Négatif' }).click();
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

/**
 * Modifier une automation (demande de Julien, 2026-10-02) : elle se supprimait et se recréait. Le formulaire se
 * rouvre avec TOUT ce qu'elle porte, l'enregistrement part en PATCH, et son état allumé ou éteint ne bouge pas.
 */
test.describe('Automation : modifier', () => {
  async function monterAvec(page: Page, automations: Array<Record<string, unknown>>, patched: Array<Record<string, unknown>>): Promise<void> {
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.endsWith('/champs-fiche')) return json(CHAMPS_FICHE);
      if (/\/automations\/a1$/.test(url) && req.method() === 'PATCH') { patched.push(req.postDataJSON() as Record<string, unknown>); return json({ id: 'a1' }); }
      if (url.endsWith('/automations')) return json({ automations });
      if (url.endsWith('/workflows')) return json({ workflows: [WF] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/automations');
  }
  const base = { id: 'a1', enabled: true, conditionGroup: null, startNodeId: null, workflowId: 'wf1' };

  test('🔴 une automation mot-clé se rouvre préremplie, et l’enregistrement part en PATCH sans toucher à son état', async ({ page }) => {
    const patched: Array<Record<string, unknown>> = [];
    await monterAvec(page, [{ ...base, name: 'Demande de RDV', triggerKind: 'keyword', triggerConfig: { keywords: ['rdv'], mode: 'equals' }, cooldownSeconds: null }], patched);
    await page.getByTestId('automation-modifier-a1').click();
    await expect(page.getByTestId('automation-name')).toHaveValue('Demande de RDV');
    await expect(page.getByTestId('automation-trigger')).toHaveValue('keyword');
    await expect(page.getByTestId('automation-keywords')).toHaveValue('rdv');
    await expect(page.getByTestId('automation-workflow')).toHaveValue('wf1');
    // Active : l'écran prévient que le changement s'applique tout de suite.
    await expect(page.getByTestId('automation-form-note')).toContainText('vos changements s’appliquent');
    await page.getByTestId('automation-keywords').fill('rdv, devis');
    await page.getByTestId('automation-submit').click();
    await expect.poll(() => patched.length).toBe(1);
    expect(patched[0]).toEqual({
      name: 'Demande de RDV', triggerKind: 'keyword', triggerConfig: { keywords: ['rdv', 'devis'], mode: 'equals' },
      workflowId: 'wf1', cooldownSeconds: null,
    });
  });

  test('🔴 « la dernière analyse change » se rouvre avec son filtre et son délai, intacts', async ({ page }) => {
    const patched: Array<Record<string, unknown>> = [];
    await monterAvec(page, [{
      ...base, enabled: false, name: 'Mécontents', triggerKind: 'analyse_devient',
      triggerConfig: { cle: 'analyse_sentiment', op: 'in', valeur: 'negatif' }, cooldownSeconds: 3 * 24 * 3600,
    }], patched);
    await page.getByTestId('automation-modifier-a1').click();
    const bloc = page.getByTestId('config-analyse-devient');
    await expect(bloc.getByRole('button', { name: 'Négatif' })).toHaveAttribute('aria-pressed', 'true');
    await expect(bloc.getByRole('button', { name: 'Positif' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('automation-anti-rebond')).toHaveValue(String(3 * 24 * 3600));
    await expect(page.getByTestId('automation-form-note')).toHaveText('Elle reste désactivée.');
    await page.getByTestId('automation-name').fill('Clients mécontents');
    await page.getByTestId('automation-submit').click();
    await expect.poll(() => patched.length).toBe(1);
    expect(patched[0]).toEqual({
      name: 'Clients mécontents', triggerKind: 'analyse_devient',
      triggerConfig: { cle: 'analyse_sentiment', op: 'in', valeur: 'negatif' }, workflowId: 'wf1', cooldownSeconds: 3 * 24 * 3600,
    });
  });
});
