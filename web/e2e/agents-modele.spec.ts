import { test, expect } from '@playwright/test';

/**
 * L'onglet Modèle d'un agent : une LISTE DÉROULANTE, plus une saisie libre (2026-09-09, demande de Julien).
 *
 * 🔴 CE QUE SEUL UN TEST DE BOUT EN BOUT PEUT VOIR ICI. Le calcul des prix est tenu par des tests unitaires,
 * la garde d'écriture par des tests de route. Ce qui reste, et qui ne se voit qu'à l'écran : que le menu
 * affiche bien le tarif à côté de chaque modèle (c'est la demande), qu'il présélectionne celui EN PLACE (un
 * menu qui montre le premier de la liste ferait croire que l'agent tourne déjà dessus), et surtout qu'un
 * catalogue injoignable ne rende PAS un menu vide, qui interdirait le geste que ce lot vient d'ouvrir.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const FICHE_VIDE = { nom: '', objectif: '', ton: '', personnalite: '', reglesTransfert: '', sorties: [] };
const AGENT = {
  id: 'ag1', label: 'Conseiller séjours', status: 'draft',
  mentionIa: 'Vous échangez avec un assistant automatique.', modele: 'zai/glm-4.7-flash',
  maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30000, inactiviteMinutes: 30,
  contactInconnu: 'lecture_seule', contenu: FICHE_VIDE, ficheVersion: 4,
};

/** Les tarifs tels que le serveur les rend : euros par million de jetons, commission comprise. */
const MODELES = [
  { id: 'zai/glm-4.7-flash', nom: 'GLM 4.7 Flash', prixEntree: 0.07084, prixSortie: 0.4048 },
  { id: 'mistral/mistral-small', nom: 'Mistral Small', prixEntree: 0.1012, prixSortie: 0.3036 },
  { id: 'anthropic/claude-haiku-4.5', nom: 'Claude Haiku 4.5', prixEntree: 1.012, prixSortie: 5.06 },
];

async function monter(page: import('@playwright/test').Page, opts: { modeles?: unknown[]; modeleAgent?: string; patches?: Array<Record<string, unknown>> } = {}) {
  const patches = opts.patches ?? [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  let courant = { ...AGENT, modele: opts.modeleAgent ?? AGENT.modele };
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    // AVANT `/agents/ag1` et `/agents` : le segment est fixe, il ne doit pas être pris pour un identifiant.
    if (/\/agents\/modeles$/.test(url)) return json({ modeles: opts.modeles ?? MODELES });
    if (req.method() === 'PATCH' && /\/agents\/ag1$/.test(url)) {
      const patch = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      patches.push(patch);
      courant = { ...courant, ...patch } as typeof courant;
      return json({ agent: courant });
    }
    if (/\/agents\/ag1$/.test(url)) return json({ agent: courant });
    if (/\/agents(\?|$)/.test(url)) return json({ agents: [{ id: 'ag1', label: 'Conseiller séjours', status: 'draft', sorties: [] }] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/agents');
  await page.getByRole('button', { name: /Conseiller séjours/ }).first().click();
  await page.getByTestId('mba-tab-modele').click();
}

test.describe('Agent : le choix du modèle', () => {
  test('🔴 c’est une LISTE, et chaque ligne porte son tarif', async ({ page }) => {
    await monter(page);
    const select = page.getByTestId('agent-modele');
    await expect(select).toBeVisible();
    // Une saisie libre n'accepterait pas `selectOption` : c'est bien un `<select>`.
    await expect(select).toHaveValue('zai/glm-4.7-flash'); // celui EN PLACE, présélectionné

    // ⚠️ `Intl.NumberFormat` en français colle une espace INSÉCABLE ÉTROITE (U+202F) devant l'euro, pas une
    // espace ordinaire. Comparer sans le savoir donne un échec où l'attendu et le reçu s'affichent
    // IDENTIQUES à l'écran, ce qui coûte un bon quart d'heure. On normalise les espaces avant d'asserter.
    const options = (await select.locator('option').allTextContents()).map((o) => o.replace(/[  ]/g, ' '));
    expect(options).toHaveLength(3);
    // Le prix, entre parenthèses, tel que Julien l'a demandé : entrée puis sortie, par million de jetons.
    expect(options[0]).toMatch(/GLM 4\.7 Flash \(0,0708 € \/ 0,4048 € par 1M jetons\)/);
    expect(options[2]).toMatch(/Claude Haiku 4\.5 \(1,01 € \/ 5,06 € par 1M jetons\)/);
  });

  test('choisir un modèle l’enregistre', async ({ page }) => {
    const patches: Array<Record<string, unknown>> = [];
    await monter(page, { patches });
    await page.getByTestId('agent-modele').selectOption('anthropic/claude-haiku-4.5');
    await expect.poll(() => patches, { timeout: 10_000 }).toEqual([{ modele: 'anthropic/claude-haiku-4.5' }]);
  });

  test('🔴 LISTE VIDE : le modèle en place reste lisible, et l’écran DIT pourquoi', async ({ page }) => {
    // Le piège à ne pas laisser passer : un menu vide. Il laisserait croire qu'aucun modèle n'existe, et
    // interdirait le seul geste que cet onglet propose.
    //
    // ⚠️ Ce n'est PAS le cas « catalogue Gateway injoignable » : celui-là rend nos dix SANS tarif, et le menu
    // reste un menu (c'est le serveur qui le garantit, `tests/agent-setup-lint.test.ts`). Une liste vide veut
    // dire que la ROUTE n'a rien rendu : réseau coupé, session expirée, backend plus ancien que la console.
    await monter(page, { modeles: [] });
    const champ = page.getByTestId('agent-modele');
    await expect(champ).toHaveValue('zai/glm-4.7-flash');
    await expect(champ).toBeDisabled();
    await expect(page.getByText(/liste des modèles est momentanément indisponible/i)).toBeVisible();
  });

  test('🔴 un modèle EN PLACE mais hors liste garde sa ligne', async ({ page }) => {
    // Sans elle, le menu afficherait le premier de la liste et ferait croire que l'agent tourne déjà dessus,
    // alors qu'il tourne sur autre chose. C'est le cas d'un agent réglé avant ce lot, ou par l'API.
    await monter(page, { modeleAgent: 'un/modele-historique' });
    const select = page.getByTestId('agent-modele');
    await expect(select).toHaveValue('un/modele-historique');
    await expect(select.locator('option').first()).toContainText(/en place, hors liste/);
  });
});
