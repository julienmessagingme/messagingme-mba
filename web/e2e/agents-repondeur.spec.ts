import { test, expect, type Page } from '@playwright/test';
import { repondre } from './aide/confirmation';

/**
 * LE RÉPONDEUR DE L'ESPACE SUR LA PAGE DES AGENTS (lot 5, livraison B ; spec
 * `docs/superpowers/specs/2026-10-04-repondeur-par-defaut-design.md`, § 3).
 *
 * Ce qu'on vérifie vraiment : seuls les agents ACTIFS se choisissent ; le choix ne part qu'au bouton « Enregistrer »,
 * jamais à la sélection (relecture de la livraison B, JB5) ; choisir un agent IA alors que l'agent de Meta est allumé
 * passe par une confirmation qui dit qu'il sera ÉTEINT pour tous les contacts, et un refus n'envoie rien ; l'état de
 * l'agent de Meta est relu AU MOMENT du geste et après une erreur, et un état illisible fait confirmer (JB3, JB4) ; les
 * contacts que Meta n'a pas retirés de sa liste sont COMPTÉS à l'écran (relecture de A, J6) ; revenir à « Aucun » se
 * confirme ; et désactiver l'agent répondeur le dit avant (revue du plan, cas 3).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const AGENTS = [
  { id: 'ag-lea', label: 'Léa', status: 'active', sorties: [], modele: 'anthropic/claude-haiku-4.5' },
  { id: 'ag-brouillon', label: 'Brouillon Paul', status: 'draft', sorties: [], modele: '' },
  { id: 'ag-ancien', label: 'Ancien Marc', status: 'disabled', sorties: [], modele: '' },
];
const FICHE = {
  id: 'ag-lea', label: 'Léa', status: 'active', mentionIa: 'Vous échangez avec un assistant automatique.', modele: 'anthropic/claude-haiku-4.5',
  maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30000, inactiviteMinutes: 30, contactInconnu: 'lecture_seule',
  contenu: { nom: '', objectif: '', ton: '', personnalite: '', reglesTransfert: '', sorties: [] }, ficheVersion: 1,
};

/**
 * Le serveur, avec son état : le réglage choisi est relu à la liste suivante, comme en vrai. `etat` est rendu pour
 * qu'un test change le monde DERRIÈRE l'écran (un autre admin qui rallume l'agent de Meta).
 * - `settingsIllisibles` : `GET /settings` échoue, l'état de l'agent de Meta est inconnu ;
 * - `echec` : le `PUT` éteint l'agent de Meta PUIS échoue en 500 (une liste de Meta qui lève à mi-chemin) ;
 * - `eteintParAilleurs` : l'agent de Meta est éteint par quelqu'un d'autre juste avant le `PUT`, qui rend donc
 *   `agentDeMetaEteint: false` (il n'avait rien à éteindre).
 */
async function monter(page: Page, o: {
  mbaEnabled: boolean; repondeurAgentId?: string | null; refuses?: number;
  settingsIllisibles?: boolean; echec?: boolean; eteintParAilleurs?: boolean;
}) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  const etat = { mbaEnabled: o.mbaEnabled, repondeurAgentId: o.repondeurAgentId ?? null, statut: FICHE.status };
  const gestes: Array<{ agentId: unknown }> = [];
  const patches: Array<Record<string, unknown>> = [];
  /** Les lectures de l'état de l'agent de Meta (`GET /settings`) : au chargement, puis à chaque geste. */
  const lectures = { settings: 0 };
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname.replace('/api/backend', '');
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'PUT' && chemin.endsWith('/agents/repondeur')) {
      const corps = (req.postDataJSON() ?? {}) as { agentId?: unknown };
      gestes.push({ agentId: corps.agentId });
      const agentId = typeof corps.agentId === 'string' ? corps.agentId : null;
      if (o.eteintParAilleurs) etat.mbaEnabled = false;
      const eteint = agentId !== null && etat.mbaEnabled;
      if (agentId !== null) etat.mbaEnabled = false;
      if (o.echec) return json({ error: 'Internal Server Error' }, 500);
      etat.repondeurAgentId = agentId;
      return json({
        repondeurAgentId: agentId, agentDeMetaEteint: eteint,
        liste: agentId === null ? { retires: 0, refuses: 0 } : { retires: 12, refuses: o.refuses ?? 0 },
      });
    }
    if (req.method() === 'PATCH' && chemin.endsWith('/agents/ag-lea')) {
      const patch = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      patches.push(patch);
      if (typeof patch.status === 'string') {
        etat.statut = patch.status;
        // Le serveur retire l'agent du rôle de répondeur quand il quitte le statut actif (`oublierRepondeur`).
        if (patch.status !== 'active' && etat.repondeurAgentId === 'ag-lea') etat.repondeurAgentId = null;
      }
      return json({ agent: { ...FICHE, status: etat.statut } });
    }
    if (chemin.endsWith('/agents/ag-lea')) return json({ agent: { ...FICHE, status: etat.statut } });
    if (chemin.endsWith('/agents/solde')) return json({ soldeMicroEur: 5_000_000 });
    if (chemin.endsWith('/agents')) {
      return json({ agents: AGENTS.map((a) => (a.id === 'ag-lea' ? { ...a, status: etat.statut } : a)), repondeurAgentId: etat.repondeurAgentId });
    }
    if (chemin.endsWith('/settings')) {
      lectures.settings += 1;
      return o.settingsIllisibles ? json({ error: 'Internal Server Error' }, 500) : json({ mbaEnabled: etat.mbaEnabled });
    }
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  return { gestes, patches, etat, lectures };
}

const choix = (page: Page) => page.getByRole('combobox', { name: 'Agent IA répondeur' });
const enregistrer = (page: Page) => page.getByRole('button', { name: 'Enregistrer' });

test.describe('Agents IA : le répondeur de l’espace', () => {
  test('🔴 seuls les agents ACTIFS se choisissent, et l’agent de Meta allumé est dit, avec son écran', async ({ page }) => {
    await monter(page, { mbaEnabled: true });
    await page.goto('/agents');
    await expect(choix(page)).toHaveValue('');
    // « Aucun » et Léa, et rien d'autre : ni le brouillon, ni l'agent désactivé.
    await expect(choix(page).locator('option')).toHaveText(['Aucun', 'Léa']);
    await expect(page.getByTestId('repondeur-agent-meta')).toContainText('L’agent de Meta est allumé sur cet espace');
    await expect(page.getByTestId('repondeur-agent-meta-lien')).toHaveAttribute('href', '/mba/parametres');
  });

  /**
   * 🔴 JB5 : LA SÉLECTION SEULE N'ENVOIE RIEN. Au clavier, chaque flèche sur une liste fermée déclenche `change` :
   * quand le choix partait à la sélection, parcourir la liste retirait puis redésignait le répondeur de tout l'espace
   * à chaque pas, sans question.
   */
  test('🔴 la sélection seule n’envoie rien, ni question ni geste : il faut « Enregistrer »', async ({ page }) => {
    const { gestes } = await monter(page, { mbaEnabled: false });
    await page.goto('/agents');
    await expect(enregistrer(page)).toBeDisabled();
    await choix(page).focus();
    await page.keyboard.press('ArrowDown');
    await choix(page).selectOption('ag-lea');
    await expect(choix(page)).toHaveValue('ag-lea');
    await expect(page.getByTestId('confirmation')).toHaveCount(0);
    await expect(page.getByTestId('repondeur-fait')).toHaveCount(0);
    expect(gestes).toEqual([]);
    await enregistrer(page).click();
    await expect(page.getByTestId('repondeur-fait')).toContainText('« Léa » répond désormais aux messages que personne ne tient.');
    expect(gestes).toEqual([{ agentId: 'ag-lea' }]);
  });

  test('🔴 choisir un agent IA, agent de Meta allumé : confirmation, un refus n’envoie rien ; puis le retour à « Aucun », confirmé', async ({ page }) => {
    const { gestes } = await monter(page, { mbaEnabled: true, refuses: 3 });
    await page.goto('/agents');
    await expect(page.getByTestId('repondeur-agent-meta')).toBeVisible();

    // Un refus : rien ne part, et le choix revient à ce qu'il était.
    await choix(page).selectOption('ag-lea');
    await enregistrer(page).click();
    await repondre(page, false, /l’agent de Meta sera éteint pour tous vos contacts de cet espace/);
    await expect(choix(page)).toHaveValue('');
    expect(gestes).toEqual([]);

    // Confirmé : le geste part, l'écran dit ce qui a changé, et COMPTE les contacts que Meta n'a pas retirés (J6).
    await choix(page).selectOption('ag-lea');
    await enregistrer(page).click();
    await repondre(page, true, /« Léa » deviendra le répondeur de l’espace/);
    await expect(page.getByTestId('repondeur-fait')).toContainText('« Léa » répond désormais aux messages que personne ne tient. L’agent de Meta est éteint.');
    await expect(page.getByTestId('repondeur-non-retires')).toContainText('3 contacts n’ont pas pu être retirés de la liste de l’agent de Meta');
    await expect(choix(page)).toHaveValue('ag-lea');
    await expect(page.getByTestId('repondeur-agent-meta')).toHaveCount(0);
    expect(gestes).toEqual([{ agentId: 'ag-lea' }]);

    // 🔴 JB5 : le retour à « Aucun » a l'effet de la désactivation de l'agent répondeur, il se confirme pareil. Refusé,
    // rien ne part et Léa reste choisie.
    await choix(page).selectOption('');
    await enregistrer(page).click();
    await repondre(page, false, /« Léa » ne sera plus le répondeur de l’espace : plus aucun agent IA ne répondra aux messages que personne ne tient/);
    await expect(choix(page)).toHaveValue('ag-lea');
    expect(gestes).toEqual([{ agentId: 'ag-lea' }]);
    await choix(page).selectOption('');
    await enregistrer(page).click();
    await repondre(page, true, /plus aucun agent IA ne répondra/);
    await expect(page.getByTestId('repondeur-fait')).toContainText('L’espace n’a plus d’agent IA répondeur : plus aucun répondeur automatique ne répond aux messages que personne ne tient.');
    await expect(choix(page)).toHaveValue('');
    expect(gestes).toEqual([{ agentId: 'ag-lea' }, { agentId: null }]);
    // Rechargée, la page relit le réglage du serveur : il est bien à « Aucun ».
    await page.reload();
    await expect(choix(page)).toHaveValue('');
  });

  test('agent de Meta éteint : le choix part sans question, et aucun contact n’est dit « non retiré »', async ({ page }) => {
    const { gestes } = await monter(page, { mbaEnabled: false });
    await page.goto('/agents');
    await expect(page.getByTestId('repondeur-agent-meta')).toHaveCount(0);
    await choix(page).selectOption('ag-lea');
    await enregistrer(page).click();
    await expect(page.getByTestId('repondeur-fait')).toContainText('« Léa » répond désormais aux messages que personne ne tient.');
    await expect(page.getByTestId('repondeur-fait')).not.toContainText('L’agent de Meta est éteint');
    await expect(page.getByTestId('repondeur-non-retires')).toHaveCount(0);
    await expect(page.getByTestId('confirmation')).toHaveCount(0);
    expect(gestes).toEqual([{ agentId: 'ag-lea' }]);
  });

  /**
   * 🔴 JB4 : L'ÉTAT DE L'AGENT DE META EST RELU AU MOMENT DU GESTE. Lu une fois au chargement, un agent de Meta rallumé
   * ailleurs entre-temps (un autre onglet, un autre admin, l'Accueil) était éteint pour tous les contacts sans la
   * question que la spec exige.
   */
  test('🔴 l’agent de Meta rallumé ailleurs après l’ouverture de la page : la confirmation est quand même posée', async ({ page }) => {
    const { gestes, etat, lectures } = await monter(page, { mbaEnabled: false });
    // La lecture du chargement doit avoir rendu « éteint » AVANT qu'on le rallume derrière l'écran : sinon elle lirait
    // déjà « allumé », et le test passerait sans relecture.
    const premiereLecture = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/settings'));
    await page.goto('/agents');
    await premiereLecture;
    await expect(choix(page)).toBeVisible();
    expect(lectures.settings).toBe(1);
    etat.mbaEnabled = true;
    await choix(page).selectOption('ag-lea');
    await enregistrer(page).click();
    await repondre(page, false, /l’agent de Meta sera éteint pour tous vos contacts de cet espace/);
    expect(lectures.settings, 'l’état de l’agent de Meta est relu au moment d’enregistrer').toBe(2);
    expect(gestes).toEqual([]);
    // Relu, il est dit allumé sur l'écran aussi.
    await expect(page.getByTestId('repondeur-agent-meta')).toBeVisible();
  });

  /** 🔴 JB3 (a) : un état illisible ne dispense pas de la question, il la pose au conditionnel. */
  test('🔴 l’état de l’agent de Meta illisible : la confirmation est posée, au conditionnel, et un refus n’envoie rien', async ({ page }) => {
    const { gestes } = await monter(page, { mbaEnabled: true, settingsIllisibles: true });
    await page.goto('/agents');
    await choix(page).selectOption('ag-lea');
    await enregistrer(page).click();
    await repondre(page, false, /Si l’agent de Meta est allumé, il sera éteint pour tous vos contacts de cet espace/);
    expect(gestes).toEqual([]);
  });

  /**
   * 🔴 JB4 : APRÈS UNE ERREUR, L'ÉCRAN RELIT. Le serveur a pu éteindre l'agent de Meta avant d'échouer : l'écran disait
   * encore « c'est lui qui répond aujourd'hui », et la question du nouvel essai annonçait qu'il « sera éteint ».
   */
  test('🔴 une erreur après que le serveur a éteint l’agent de Meta : l’écran le relit, et le choix revient au réglage', async ({ page }) => {
    const { gestes } = await monter(page, { mbaEnabled: true, echec: true });
    await page.goto('/agents');
    await expect(page.getByTestId('repondeur-agent-meta')).toBeVisible();
    await choix(page).selectOption('ag-lea');
    await enregistrer(page).click();
    await repondre(page, true, /l’agent de Meta sera éteint/);
    await expect(page.getByTestId('repondeur-erreur')).toBeVisible();
    await expect(page.getByTestId('repondeur-agent-meta')).toHaveCount(0);
    await expect(choix(page)).toHaveValue('');
    expect(gestes).toEqual([{ agentId: 'ag-lea' }]);
  });

  /** 🔴 JB4 : toute réussite qui désigne un agent dit l'agent de Meta éteint, même quand ce geste n'avait rien à éteindre. */
  test('🔴 l’agent de Meta éteint par ailleurs pendant la question : la réussite ne le dit plus allumé', async ({ page }) => {
    await monter(page, { mbaEnabled: true, eteintParAilleurs: true });
    await page.goto('/agents');
    await expect(page.getByTestId('repondeur-agent-meta')).toBeVisible();
    await choix(page).selectOption('ag-lea');
    await enregistrer(page).click();
    await repondre(page, true);
    await expect(page.getByTestId('repondeur-fait')).toContainText('« Léa » répond désormais aux messages que personne ne tient.');
    await expect(page.getByTestId('repondeur-fait')).not.toContainText('L’agent de Meta est éteint');
    await expect(page.getByTestId('repondeur-agent-meta')).toHaveCount(0);
  });

  test('🔴 désactiver l’agent répondeur le dit avant : il quitte ce rôle, et la liste le montre', async ({ page }) => {
    const { patches } = await monter(page, { mbaEnabled: false, repondeurAgentId: 'ag-lea' });
    await page.goto('/agents');
    await expect(choix(page)).toHaveValue('ag-lea');
    await page.getByTestId('agent-ligne-ag-lea').click();
    await page.getByTestId('agent-activer').click();
    // Un refus : l'agent reste actif, et répondeur.
    await repondre(page, false, /« Léa » est le répondeur de l’espace : le désactiver le retire de ce rôle/);
    expect(patches).toEqual([]);
    await page.getByTestId('agent-activer').click();
    await repondre(page, true);
    await expect.poll(() => patches).toEqual([{ status: 'disabled' }]);
    await page.getByRole('button', { name: /Retour aux agents/ }).click();
    await expect(choix(page)).toHaveValue('');
  });
});
