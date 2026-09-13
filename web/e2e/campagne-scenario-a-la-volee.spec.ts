import { test, expect, type Page } from '@playwright/test';
import { TREIZE_POUCES, pasDeDebordement } from './aide/largeur';

/**
 * CRÉER UN SCÉNARIO SANS QUITTER SA CAMPAGNE.
 *
 * 🔴 CE QUI EST VÉRIFIÉ ICI, ET QU'AUCUN TEST UNITAIRE NE PEUT VOIR : l'étage ne se voit proposer que les
 * scénarios capables de l'ouvrir, on ne crée RIEN sans nom, l'éditeur s'ouvre dans une fenêtre sans faire
 * perdre le brouillon de la campagne, et la fenêtre tient en 13 pouces.
 *
 * ⚠️ L'ÉTAT D'OUVERTURE PASSE PAR L'ADRESSE (`?etape=contenu&canal=...`), comme les autres e2e de cette
 * étape : sans cela, chaque cas rejouerait l'étape Canal et rougirait le jour où l'écran d'à côté bouge.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const TEMPLATES = [{ id: 't1', name: 'promo_rentree', status: 'APPROVED', category: 'MARKETING', language: 'fr' }];

/** Deux scénarios publiés : un qui ouvre en WhatsApp, un qui ouvre en RCS. */
const WORKFLOWS = [
  { id: 'wf-wa', name: 'Bienvenue WhatsApp', campaignEligible: true, canalOuverture: 'whatsapp' },
  { id: 'wf-rcs', name: 'Bienvenue RCS', campaignEligible: true, canalOuverture: 'rcs' },
];

async function monter(page: Page, o: { canal?: string; creations?: string[] } = {}): Promise<void> {
  const creations = o.creations ?? [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname.replace('/api/backend', '');
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    // ⚠️ LA CRÉATION AVANT LA LISTE : les deux sont sur `/workflows`, et tester la liste d'abord avalerait
    // le POST sans que rien ne le signale.
    if (chemin.endsWith('/workflows') && req.method() === 'POST') {
      const corps = (req.postDataJSON() ?? {}) as { name?: string };
      creations.push(String(corps.name ?? ''));
      return json({ id: 'wf-neuf', name: corps.name, graph: { nodes: [], edges: [] } });
    }
    if (chemin.endsWith('/workflows')) return json({ workflows: WORKFLOWS });
    if (chemin.endsWith('/settings')) {
      return json({
        controlHandbackSeconds: null, mbaHandoffMode: null, mbaEnabled: true, rcsEnabled: true,
        hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: true,
        timezone: 'Europe/Paris', businessHours: {},
      });
    }
    if (chemin.endsWith('/templates')) return json({ templates: TEMPLATES });
    if (chemin.endsWith('/email-templates')) return json({ templates: [] });
    if (chemin.endsWith('/users')) return json({ users: [] });
    if (chemin.endsWith('/agents')) return json({ agents: [] });
    return json({});
  });
  const q = new URLSearchParams({ etape: 'contenu', canal: o.canal ?? 'whatsapp' });
  await page.goto(`/campaigns/nouvelle?${q.toString()}`);
  await expect(page.getByTestId('etape-contenu')).toBeVisible();
}

/** Déplie l'étage 1 et bascule en formule « modèle et scénario ». */
async function enFormuleScenario(page: Page): Promise<void> {
  await page.getByTestId('etage-1').click();
  await page.getByRole('radio', { name: 'Modèle et scénario' }).check();
}

test.describe('Créer un scénario depuis une campagne', () => {
  /**
   * 🔴 L'ÉTAGE NE SE VOIT PROPOSER QUE CE QUI PEUT L'OUVRIR. Un scénario qui ouvre en RCS, proposé sur un
   * étage WhatsApp, fait refuser la campagne ENTIÈRE par Meta, pas un destinataire.
   */
  test('🔴 un etage WhatsApp ne propose pas un scenario qui ouvre en RCS', async ({ page }) => {
    await monter(page);
    await enFormuleScenario(page);
    const options = page.getByTestId('scenario-1').locator('option');
    await expect(options.filter({ hasText: 'Bienvenue WhatsApp' })).toHaveCount(1);
    await expect(options.filter({ hasText: 'Bienvenue RCS' })).toHaveCount(0);
  });

  test('🔴 sans nom, on ne cree RIEN', async ({ page }) => {
    const creations: string[] = [];
    await monter(page, { creations });
    await enFormuleScenario(page);
    await page.getByTestId('creer-scenario').click();
    await expect(page.getByTestId('creer-scenario-champ')).toBeVisible();
    // Un scénario « sans titre » est introuvable dans une liste trois jours plus tard, et c'est cette
    // liste qui sert à le retrouver.
    await expect(page.getByTestId('creer-scenario-valider')).toBeDisabled();
    expect(creations).toEqual([]);
  });

  test('le nom est demande AVANT l editeur, et il part tel quel', async ({ page }) => {
    const creations: string[] = [];
    await monter(page, { creations });
    await enFormuleScenario(page);
    await page.getByTestId('creer-scenario').click();
    await page.getByTestId('creer-scenario-champ').fill('Relance panier');
    await page.getByTestId('creer-scenario-valider').click();
    await expect(page.getByTestId('fenetre-scenario')).toBeVisible();
    expect(creations).toEqual(['Relance panier']);
  });

  /**
   * 🔴 LE BROUILLON DE LA CAMPAGNE SURVIT À L'OUVERTURE. C'est la raison d'être de la fenêtre plutôt que
   * d'un lien vers l'onglet Scénario : on ne quitte pas la page, donc on ne perd pas ce qui est saisi.
   */
  test('🔴 le contenu deja saisi survit a l ouverture puis a la fermeture de l editeur', async ({ page }) => {
    await monter(page);
    await page.getByTestId('etage-1').click();
    await page.getByTestId('modele-1').selectOption('promo_rentree');
    await page.getByRole('radio', { name: 'Modèle et scénario' }).check();
    await page.getByTestId('scenario-1').selectOption('wf-wa');

    await page.getByTestId('creer-scenario').click();
    await page.getByTestId('creer-scenario-champ').fill('Relance panier');
    await page.getByTestId('creer-scenario-valider').click();
    await expect(page.getByTestId('fenetre-scenario')).toBeVisible();
    await page.getByTestId('fenetre-scenario-fermer').click();
    await expect(page.getByTestId('fenetre-scenario')).toHaveCount(0);
    // Le choix d'avant est toujours là : la fenêtre s'est superposée, elle n'a pas remonté l'écran.
    await expect(page.getByTestId('scenario-1')).toHaveValue('wf-wa');
  });

  test('⚠️ un etage RCS propose lui aussi de creer, et exige SON canal', async ({ page }) => {
    // Le scénario d'un étage RCS part APRÈS son message ; il doit donc ouvrir en RCS, pas en WhatsApp.
    await monter(page, { canal: 'rcs' });
    await page.getByTestId('etage-1').click();
    await page.getByRole('radio', { name: 'Message et scénario' }).check();
    await expect(page.getByTestId('creer-scenario')).toBeVisible();
  });

  /**
   * 🔴 LA GARDE DEMANDÉE PAR JULIEN. Sur un étage WhatsApp, un scénario qui n'ouvre pas par un modèle ne
   * doit pas pouvoir être publié DEPUIS la campagne : le dire ici évite de construire tout un parcours
   * avant de l'apprendre au récapitulatif. Une campagne dont l'ouverture ne convient pas est refusée
   * ENTIÈREMENT par Meta, pas destinataire par destinataire.
   */
  test('🔴 publier refuse un scenario qui n ouvre pas par un modele, sur un etage WhatsApp', async ({ page }) => {
    await monter(page);
    await enFormuleScenario(page);
    await page.getByTestId('creer-scenario').click();
    await page.getByTestId('creer-scenario-champ').fill('Relance panier');
    await page.getByTestId('creer-scenario-valider').click();
    await expect(page.getByTestId('fenetre-scenario')).toBeVisible();

    // Une ATTENTE en premier bloc : rien ne part au lancement, donc ce scénario ne peut ouvrir personne.
    await page.getByTestId('add-node-wait').click();
    await page.getByTestId('workflow-publier').click();
    await expect(page.getByTestId('refus-ouverture')).toContainText(/ne commence pas par un modèle WhatsApp/i);
    // ...et la fenêtre RESTE ouverte : on refuse, on ne fait pas disparaître le travail en cours.
    await expect(page.getByTestId('fenetre-scenario')).toBeVisible();
  });

  test('rien ne deborde en 13 pouces', async ({ page }) => {
    await monter(page);
    await page.setViewportSize(TREIZE_POUCES);
    await enFormuleScenario(page);
    await page.getByTestId('creer-scenario').click();
    await page.getByTestId('creer-scenario-champ').fill('Relance panier');
    await page.getByTestId('creer-scenario-valider').click();
    await expect(page.getByTestId('fenetre-scenario')).toBeVisible();
    await pasDeDebordement(page);
  });
});
