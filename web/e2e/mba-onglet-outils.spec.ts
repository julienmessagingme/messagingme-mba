import { test, expect } from '@playwright/test';
import { mockMba, TENANT } from './support/mba';

/**
 * L'onglet OUTILS du paramétrage MBA.
 *
 * 🔴 CE QU'IL RÉPARE, ET CE N'EST PAS UN CONFORT. La case qui décide ce que l'agent de Meta a le droit
 * d'appeler, le bouton qui crée un outil pour lui sans passer par un agent IA, et la publication chez Meta
 * vivent tous les trois sur UN SEUL écran, `Tools > Outils`, et nulle part ailleurs (`exposerOutilAuMba` et
 * `publierChezMeta` n'ont chacun qu'un appelant). Or le paramétrage du MBA portait dix onglets et aucun ne
 * s'appelait Outils : quelqu'un qui configure son MBA cherche ses outils dans les onglets du MBA.
 * Julien les y a cherchés le 2026-09-16 et ne les a pas trouvés.
 *
 * ⚠️ ET C'EST DÉSORMAIS LE SEUL CHEMIN (2026-09-18). Cette page disait « sa place reste bien dans Tools,
 * deux chemins vers un écran unique » : l'entrée `Tools > Outils` a été retirée à la demande de Julien.
 * Depuis 0157 une ACTION appartient à son agent, et 0159 INTERDIT en base qu'une action vive au niveau de
 * l'espace : il ne restait là-bas qu'un écran dont le titre promettait un inventaire qu'il ne pouvait plus
 * contenir. L'adresse `/outils` reste servie, les liens déjà partagés ne se cassent pas.
 */
test.describe('MBA Paramètres : onglet Outils', () => {
  const OUTIL = {
    id: 'o1',
    name: 'suivi_commande',
    title: 'Suivi de commande',
    description: 'Rend l’état d’une commande.',
    origin: 'http',
    risk: 'read',
    sourceId: 's1',
    mcpNonActivable: null,
    mcpIndisponibleLe: null,
    consommateurs: [{ cle: 'agent:AG1', actif: true, agentId: 'AG1', agentLabel: 'Assistant' }],
  };

  async function mockAvecOutils(page: Parameters<typeof mockMba>[0], outils: unknown[]): Promise<void> {
    await mockMba(page, {
      custom: async (route, method, url) => {
        if (method === 'GET' && url.includes(`/tenants/${TENANT}/agent-tools`)) {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ outils }) });
          return true;
        }
        return false;
      },
    });
  }

  test('🔴 l’onglet Outils du MBA mène à la bibliothèque, et à ce qui décide ce que Meta peut appeler', async ({ page }) => {
    await mockAvecOutils(page, [OUTIL]);
    await page.goto('/mba/parametres');

    await page.getByTestId('mba-tab-outils').click();

    await expect(page.getByTestId('bibliotheque-outils')).toBeVisible();
    // Les deux gestes qui n'existent QUE là. Sans eux, l'onglet ne serait qu'un raccourci décoratif.
    await expect(page.getByTestId('publication-mba')).toBeVisible();
    await expect(page.getByTestId('outil-suivi_commande')).toBeVisible();
  });

  test('🔴 un outil MCP MORT ne ressemble pas a un outil vivant, et la raison est LISIBLE', async ({ page }) => {
    /**
     * 🔴 LA BIBLIOTHEQUE NE LISAIT PAS L ETAT MCP. `listCatalogue` ne selectionnait ni
     * `mcp_non_activable` ni `mcp_indisponible_le`, alors que le plan avait pose un paragraphe entier
     * pour que cet oubli soit impossible. Resultat : un outil dont le schema n est pas representable, ou
     * qui a DISPARU du serveur distant, s affichait EXACTEMENT comme les autres. Le client ne l apprenait
     * qu en cliquant « activer » et en recevant un 409.
     */
    await mockAvecOutils(page, [
      { ...OUTIL, id: 'o2', name: 'mcp_tordu', title: 'Schema tordu', origin: 'mcp',
        mcpNonActivable: 'le parametre « lignes » est un tableau', mcpIndisponibleLe: null },
      { ...OUTIL, id: 'o3', name: 'mcp_parti', title: 'Parti', origin: 'mcp',
        mcpNonActivable: null, mcpIndisponibleLe: '2026-09-17T08:00:00.000Z' },
      OUTIL,
    ]);
    await page.goto('/mba/parametres?tab=outils');

    await expect(page.getByTestId('outil-non-activable-o2')).toBeVisible();
    // La raison vient du SERVEUR : le client ne peut pas la corriger, mais il doit pouvoir la montrer.
    await expect(page.getByTestId('outil-raison-o2')).toContainText('lignes');
    await expect(page.getByTestId('outil-disparu-o3')).toBeVisible();

    // ⚠️ LA PREUVE INVERSE : sans elle, des pastilles affichees en permanence passeraient le test.
    await expect(page.getByTestId('outil-non-activable-o1')).toHaveCount(0);
    await expect(page.getByTestId('outil-disparu-o1')).toHaveCount(0);
  });

  test('l’onglet s’ouvre aussi par l’adresse, comme les dix autres', async ({ page }) => {
    // ⚠️ `lireOnglet` retombe sur « apercu » pour toute valeur inconnue : un onglet ajouté à la liste des
    // libellés mais oublié dans `ONGLETS` rendrait un lien partagé silencieusement faux.
    await mockAvecOutils(page, []);
    await page.goto('/mba/parametres?tab=outils');
    await expect(page.getByTestId('bibliotheque-outils')).toBeVisible();
  });
  /**
   * 🔴 L'ORDRE DU FORMULAIRE, ET C'EST TOUT CE QUI COMPTE ICI (Julien, 2026-09-18).
   *
   * Les quatre textes que Meta lit arrivaient AVANT le choix de l'appel, et le bloc entier était replié
   * derrière un lien discret pendant que l'état vide renvoyait vers l'onglet Outils d'un agent. Julien a
   * suivi ce texte, n'a rien trouvé là-bas, et a conclu qu'il n'existait AUCUN endroit où nommer et décrire
   * son outil. On choisit donc l'appel d'abord, et les détails n'apparaissent qu'ensuite.
   *
   * ⚠️ IL ASSERTE SUR CE QUI PART, pas sur ce que l'écran affiche : c'est le corps du POST qui prouve que le
   * bon appel a été retenu et que les quatre textes l'accompagnent.
   */
  test('🔴 on choisit l’appel D’ABORD, les détails n’apparaissent qu’après, et Soumettre les envoie', async ({ page }) => {
    const posts: Array<Record<string, unknown>> = [];
    await mockMba(page, {
      custom: async (route, method, url) => {
        if (method === 'GET' && url.includes(`/tenants/${TENANT}/agent-tools`)) {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ outils: [] }) });
          return true;
        }
        if (method === 'GET' && url.includes(`/tenants/${TENANT}/agent-requetes`)) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              requetes: [{
                id: 'REQ1', tenantId: TENANT, sourceId: 's1', label: 'Poser une étiquette',
                methode: 'POST', chemin: '/subscriber/add-tag', parametres: [], entetes: [],
                corps: { mode: 'aucun' }, variables: [], outputPaths: [], valeursTest: {},
              }],
              champs: [], catalogue: {},
            }),
          });
          return true;
        }
        if (method === 'POST' && url.includes('/agent-tools/connecteur-mba')) {
          posts.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
          await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'o9', expose: true }) });
          return true;
        }
        return false;
      },
    });
    await page.goto('/mba/parametres?tab=outils');

    // L'appel est visible SANS avoir rien déplié, et les détails ne sont PAS encore là.
    await expect(page.getByTestId('outil-mba-appels')).toContainText('Poser une étiquette');
    await expect(page.getByTestId('outil-mba-details')).toHaveCount(0);

    await page.getByTestId('outil-mba-choisir-REQ1').click();
    await expect(page.getByTestId('outil-mba-details')).toBeVisible();
    // Le titre et le nom technique sont dérivés du libellé : on ne redemande pas ce qu'on sait déjà.
    await expect(page.getByTestId('outil-mba-titre')).toHaveValue('Poser une étiquette');
    await expect(page.getByTestId('outil-mba-nom')).toHaveValue('poser_une_etiquette');

    // ⚠️ LES DEUX TEXTES RESTENT VIDES, et le bouton refuse tant qu'ils le sont : les deviner fabriquerait
    // une consigne que personne n'a écrite, sur laquelle le modèle agirait pourtant.
    await expect(page.getByTestId('outil-mba-creer')).toBeDisabled();
    await page.getByTestId('outil-mba-description').fill('Quand le client accepte le rendez-vous.');
    await page.getByTestId('outil-mba-nepasutiliser').fill('Jamais pour annuler.');
    await page.getByTestId('outil-mba-creer').click();

    await expect.poll(() => posts.length, { timeout: 5000 }).toBe(1);
    expect(posts[0]).toMatchObject({
      requeteId: 'REQ1',
      name: 'poser_une_etiquette',
      title: 'Poser une étiquette',
      description: 'Quand le client accepte le rendez-vous.',
      nePasUtiliser: 'Jamais pour annuler.',
    });
  });
});
