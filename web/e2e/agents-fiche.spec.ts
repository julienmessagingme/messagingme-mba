import { test, expect } from '@playwright/test';

/**
 * Écran de réglage d'un agent IA : la liste, la création, les onglets, les règles d'arrêt et l'activation.
 *
 * Ce qu'on vérifie vraiment ici : un agent naît en BROUILLON et n'est proposable qu'une fois ACTIVÉ (c'est
 * ce geste, et lui seul, qui le fait apparaître dans le builder), et le code d'une règle d'arrêt est
 * normalisé SOUS LES YEUX du client vers ce que le serveur accepte, plutôt que refusé après coup.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const FICHE_VIDE = { nom: '', objectif: '', ton: '', personnalite: '', reglesTransfert: '', sorties: [] };
const AGENT = {
  id: 'ag1', label: 'Conseiller séjours', status: 'draft',
  mentionIa: 'Vous échangez avec un assistant automatique.', modele: 'modele-test',
  maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30000, inactiviteMinutes: 30,
  contactInconnu: 'lecture_seule', contenu: FICHE_VIDE, ficheVersion: 4,
};

type Patch = Record<string, unknown>;

async function mockAgents(page: import('@playwright/test').Page, patches: Patch[], liste: unknown[] = [{ id: 'ag1', label: 'Conseiller séjours', status: 'draft', sorties: [], modele: 'anthropic/claude-haiku-4.5' }]) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  let courant = { ...AGENT };
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && /\/agents$/.test(url)) {
      const body = (req.postDataJSON() ?? {}) as { label?: string };
      courant = { ...AGENT, label: body.label ?? 'X', status: 'draft' };
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ agent: courant }) });
    }
    if (req.method() === 'PATCH' && /\/agents\/ag1$/.test(url)) {
      const patch = (req.postDataJSON() ?? {}) as Patch;
      patches.push(patch);
      courant = { ...courant, ...patch } as typeof courant;
      return json({ agent: courant });
    }
    if (/\/agents\/ag1$/.test(url)) return json({ agent: courant });
    if (/\/agents(\?|$)/.test(url)) return json({ agents: liste });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Agents IA : la fiche', () => {
  test('🔴 la NAV mène à l écran, et un agent se crée en BROUILLON', async ({ page }) => {
    // Le groupe « AI Agent » rassemble les deux répondeurs que le client peut faire parler : l'agent de Meta
    // et le nôtre. Le groupe `mba` d'avant a disparu au profit de celui-ci, et rien d'autre ne le couvre.
    const patches: Patch[] = [];
    await mockAgents(page, patches, []);
    await page.goto('/accueil');

    // ⚠️ « Other AI agent » EST DEVENU UN GROUPE le 2026-09-08 (il porte Agents et Crédit) : ce n'est plus
    // un lien, c'est un bouton qui déplie. Le cas gardé est le MÊME, « la nav mène à l'écran » ; seul le
    // chemin gagne un cran. C'est la CI qui l'a signalé, et c'est exactement son rôle : le regroupement a
    // été fait dans un autre fichier, rien dans le type ne reliait les deux.
    await page.getByRole('button', { name: 'AI Agent' }).click();
    await page.getByRole('button', { name: 'Other AI agent' }).click();
    await page.getByRole('link', { name: 'Agents', exact: true }).click();
    await expect(page).toHaveURL(/\/agents/);

    await expect(page.getByText('Vos agents')).toBeVisible();
    await page.getByTestId('agent-nouveau-label').fill('Conseiller séjours');
    await page.getByTestId('agent-creer').click();

    // On tombe directement dans la fiche, et elle est en brouillon.
    await expect(page.getByTestId('agent-statut-draft').first()).toBeVisible();

    /**
     * 🔴 ET SUR « CONSTRUIRE EN PARLANT », pas sur le formulaire (2026-09-08).
     *
     * Julien : « il faut que la fenêtre s'ouvre sur Construire en parlant ». La règle était écrite dans
     * `page.tsx` depuis le 2026-08-31 et ce chemin ne la suivait pas : il ouvrait « Identité et ton », c'est
     * à dire le seul endroit où l'on tombe sur des champs VIDES à remplir seul, et sur un agent qu'on vient
     * tout juste de créer, donc au moment précis où l'on a le moins d'idée de quoi y écrire.
     *
     * ⚠️ Ce test vérifiait ici `agent-label`, un champ de l'onglet Identité : il exerçait donc le mauvais
     * onglet, et c'est lui qui aurait dû faire échouer le correctif. L'assertion qu'il portait vraiment (« on
     * tombe dans la fiche du bon agent ») est conservée juste au-dessus par le badge « brouillon », et le
     * nom se relit ci-dessous, sur l'onglet où l'on arrive.
     */
    await expect(page).toHaveURL(/tab=construction/);
    await expect(page.getByTestId('setup-vide')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Conseiller séjours' })).toBeVisible();
  });

  test('🔴 activer est le seul geste qui rend l agent proposable dans un scénario', async ({ page }) => {
    const patches: Patch[] = [];
    await mockAgents(page, patches);
    await page.goto('/agents');
    await page.getByTestId('agent-ligne-ag1').click();

    await expect(page.getByTestId('agent-statut-draft').first()).toBeVisible();
    await page.getByTestId('agent-activer').click();

    expect(patches).toContainEqual({ status: 'active' });
    await expect(page.getByTestId('agent-statut-active').first()).toBeVisible();
    // Et on peut le redésactiver : le même bouton fait l'aller et le retour.
    await page.getByTestId('agent-activer').click();
    expect(patches).toContainEqual({ status: 'disabled' });
  });

  test('les champs de la fiche s enregistrent à la sortie du champ', async ({ page }) => {
    const patches: Patch[] = [];
    await mockAgents(page, patches);
    await page.goto('/agents');
    await page.getByTestId('agent-ligne-ag1').click();
    // L'onglet d'entrée est « Construire en parlant » depuis le 2026-08-31 : un test qui édite les champs de
    // la fiche doit DIRE qu'il va sur « Identité et ton », comme le ferait un utilisateur.
    await page.getByTestId('mba-tab-identite').click();

    await page.getByTestId('agent-nom').fill('Léa');
    await page.getByTestId('agent-ton').click(); // sortie du champ précédent
    await expect.poll(() => patches.some((p) => (p.contenu as { nom?: string } | undefined)?.nom === 'Léa'), { timeout: 5000 }).toBe(true);
  });

  test('🔴 le code d une règle d arrêt est NORMALISÉ sous les yeux du client', async ({ page }) => {
    // Le code devient un handle d'arête dans le builder : le serveur refuse tout ce qui sort de son alphabet.
    // Le montrer en direct vaut mieux qu'un 400 sur un champ que le client croyait bon.
    const patches: Patch[] = [];
    await mockAgents(page, patches);
    await page.goto('/agents');
    await page.getByTestId('agent-ligne-ag1').click();
    await page.getByTestId('mba-tab-objectif').click();

    await page.getByTestId('agent-sortie-code').fill('Besoin cerné');
    await expect(page.getByTestId('agent-sortie-code-normalise')).toHaveText('besoin_cerne');

    await page.getByTestId('agent-sortie-label').fill('Besoin cerné');
    await page.getByTestId('agent-sortie-ajouter').click();

    await expect.poll(
      () => patches.some((p) => {
        const s = (p.contenu as { sorties?: Array<{ code?: string }> } | undefined)?.sorties ?? [];
        return s.some((x) => x.code === 'besoin_cerne');
      }),
      { timeout: 5000 },
    ).toBe(true);
    await expect(page.getByTestId('agent-sortie-besoin_cerne')).toBeVisible();
  });

  test('une règle d arrêt se retire, et le retrait est enregistré', async ({ page }) => {
    const patches: Patch[] = [];
    await mockAgents(page, patches);
    await page.route('**/api/backend/**/agents/ag1', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ agent: { ...AGENT, contenu: { ...FICHE_VIDE, sorties: [{ code: 'rdv', label: 'Rendez-vous pris' }] } } }),
      });
    });
    await page.goto('/agents');
    await page.getByTestId('agent-ligne-ag1').click();
    await page.getByTestId('mba-tab-objectif').click();

    await expect(page.getByTestId('agent-sortie-rdv')).toBeVisible();
    await page.getByTestId('agent-sortie-retirer-rdv').click();

    await expect.poll(
      () => patches.some((p) => {
        const c = p.contenu as { sorties?: unknown[] } | undefined;
        return c !== undefined && (c.sorties ?? []).length === 0;
      }),
      { timeout: 5000 },
    ).toBe(true);
  });

  test('🔴 un patch de FICHE porte le verrou de version, un patch de colonne non', async ({ page }) => {
    // Le verrou est ce qui empêche deux surfaces (le formulaire et l'IA de construction qui vient) de
    // s'écraser en silence sur la même clé. Il n'a de sens que sur la fiche : activer un agent ne touche
    // aucune clé jsonb, et exiger la version là aussi refuserait des gestes parfaitement légitimes.
    const patches: Patch[] = [];
    await mockAgents(page, patches);
    await page.goto('/agents');
    await page.getByTestId('agent-ligne-ag1').click();
    // L'onglet d'entrée est « Construire en parlant » depuis le 2026-08-31 : un test qui édite les champs de
    // la fiche doit DIRE qu'il va sur « Identité et ton », comme le ferait un utilisateur.
    await page.getByTestId('mba-tab-identite').click();

    await page.getByTestId('agent-nom').fill('Léa');
    await page.getByTestId('agent-ton').click();
    await expect.poll(() => patches.some((p) => p.ficheVersionAttendue === 4), { timeout: 5000 }).toBe(true);

    await page.getByTestId('agent-activer').click();
    await expect.poll(
      () => patches.some((p) => p.status === 'active' && !('ficheVersionAttendue' in p)),
      { timeout: 5000 },
    ).toBe(true);
  });

  test('une erreur du serveur est ANNONCÉE, pas avalée', async ({ page }) => {
    const patches: Patch[] = [];
    await mockAgents(page, patches);
    await page.route('**/api/backend/**/agents/ag1', (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'la fiche a changé depuis son chargement' }) });
    });
    await page.goto('/agents');
    await page.getByTestId('agent-ligne-ag1').click();
    await page.getByTestId('mba-tab-identite').click();
    await page.getByTestId('agent-nom').fill('Léa');
    await page.getByTestId('agent-ton').click();

    await expect(page.getByTestId('agent-erreur')).toBeVisible();
  });

  test('un plafond hors bornes est REFUSÉ par le champ, sans aller-retour serveur', async ({ page }) => {
    // La base borne `max_tours` entre 1 et 20 : laisser partir un 0 rendrait une erreur technique pour une
    // saisie que le champ savait déjà mauvaise.
    const patches: Patch[] = [];
    await mockAgents(page, patches);
    await page.goto('/agents');
    await page.getByTestId('agent-ligne-ag1').click();
    await page.getByTestId('mba-tab-perimetre').click();

    await page.getByTestId('agent-max-tours').fill('99');
    await page.getByTestId('agent-inactivite').click();
    await expect(page.getByTestId('agent-max-tours')).toHaveValue('8'); // remis à la valeur enregistrée
    expect(patches.some((p) => 'maxTours' in p)).toBe(false);

    // Et une valeur DANS les bornes passe bien.
    await page.getByTestId('agent-max-tours').fill('12');
    await page.getByTestId('agent-inactivite').click();
    await expect.poll(() => patches.some((p) => p.maxTours === 12), { timeout: 5000 }).toBe(true);
  });
});
