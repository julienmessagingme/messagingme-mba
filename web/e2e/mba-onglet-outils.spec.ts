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
 * ⚠️ C'EST LE MÊME ÉCRAN, PAS UNE COPIE. La bibliothèque appartient à l'ESPACE et sert tous les
 * consommateurs : sa place reste bien dans `Tools`. Deux chemins vers un écran unique, ce qui est
 * exactement ce que ce test vérifie en s'accrochant aux `data-testid` du composant existant.
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
});
