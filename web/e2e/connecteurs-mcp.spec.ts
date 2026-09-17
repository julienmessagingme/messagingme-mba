import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * L'ÉCRAN DES CONNECTEURS MCP.
 *
 * 🔴 CE QU'IL DOIT MONTRER, ET QUI N'EXISTE NULLE PART AILLEURS : l'aperçu AVANT l'import (un
 * rafraîchissement fait tomber des consentements), la raison en clair d'un outil non activable, et le fait
 * que ces outils ne vont PAS à l'agent de Meta. Ce dernier point est écrit, pas grisé : une case désactivée
 * sans explication envoie le client ouvrir un ticket pour une limite qui n'est pas la nôtre.
 */

const TENANT = 't-e2e';
const SOURCE = '22222222-2222-2222-2222-222222222222';
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: TENANT };

const SERVEUR = {
  id: SOURCE, label: 'Notion', baseUrl: 'https://exemple.test/mcp',
  authKind: 'bearer', authHeaderName: null, status: 'active',
  lastOkAt: null, lastError: null,
};

const OUTILS = [
  {
    id: 'o1', name: 'notion_search', nomDistant: 'search', title: 'Chercher', description: 'cherche des pages',
    nePasUtiliser: '', risk: 'read', annonce: {}, nonActivable: null, indisponibleLe: null, consommateursActifs: 0,
    params: [
      { name: 'q', type: 'string', source: 'modele', required: true, cheminMcp: 'q' },
      { name: 'client_id', type: 'string', source: 'modele', cheminMcp: 'client.id' },
    ],
  },
  {
    id: 'o2', name: 'notion_creer', nomDistant: 'creer', title: 'Créer une page', description: 'crée une page',
    nePasUtiliser: '', risk: 'write', annonce: {}, indisponibleLe: null, consommateursActifs: 0, params: [],
    nonActivable: '« lignes » : c’est une liste, et nous ne savons pas encore la remplir en sûreté',
  },
];

async function mock(page: Page, over: { plan?: unknown; tronque?: boolean } = {}): Promise<Array<{ method: string; url: string }>> {
  const appels: Array<{ method: string; url: string }> = [];
  await page.addInitScript((s) => {
    window.localStorage.setItem('mba.session', JSON.stringify(s));
  }, SESSION);
  await page.route('**/api/backend/**', async (route: Route) => {
    const url = route.request().url();
    const method = route.request().method();
    appels.push({ method, url });
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/mcp/') && url.endsWith('/outils')) {
      // Les deux listes de clouage viennent du SERVEUR : l ecran ne les recopie pas.
      return json({ outils: OUTILS, champs: ['email', 'reference'], champsContact: ['wa_id', 'nom'] });
    }
    if (url.endsWith(`/agents/${TENANT}/mcp`)) return json({ serveurs: [SERVEUR] });
    if (url.includes('/apercu')) {
      return json({
        plan: over.plan ?? [{ type: 'schema_change', nom: 'search', consentementsTombes: 2 }],
        tronque: over.tronque ?? false,
      });
    }
    if (url.includes('/importer')) return json({ plan: [], tronque: false });
    if (url.includes('/eprouver')) return json({ ok: true });
    return json({});
  });
  return appels;
}

test.describe('Tools > Connecteurs MCP', () => {
  test('🔴 l’écran DIT que l’agent de Meta ne peut pas recevoir ces outils', async ({ page }) => {
    await mock(page);
    await page.goto('/connecteurs-mcp');
    await expect(page.getByTestId('mcp-note-mba')).toBeVisible();
    await expect(page.getByTestId('mcp-note-mba')).toContainText('Meta');
  });

  test('🔴 l’aperçu montre ce qui va tomber, et n’importe RIEN tant qu’on n’a pas cliqué', async ({ page }) => {
    // 🔴 Un rafraîchissement peut faire tomber des consentements : écraser n'est acceptable que si l'on
    // montre quoi avant de le faire. Un aperçu qui importerait serait un import qui ment sur son nom.
    const appels = await mock(page);
    await page.goto('/connecteurs-mcp');
    await page.getByTestId(`mcp-apercu-${SOURCE}`).click();
    await expect(page.getByTestId(`mcp-plan-${SOURCE}`)).toContainText('search');
    await expect(page.getByTestId(`mcp-plan-${SOURCE}`)).toContainText('2 agent(s)');
    expect(appels.filter((a) => a.url.includes('/importer'))).toHaveLength(0);
  });

  test('🔴 un catalogue TRONQUÉ prévient que rien ne sera retiré', async ({ page }) => {
    // Le client doit savoir que la liste est partielle ET ce que ça implique : sur un catalogue tronqué,
    // l'import n'enlève rien, sinon il débrancherait tout ce qui vit au delà de la borne.
    await mock(page, { tronque: true, plan: [{ type: 'nouveau', nom: 'search' }] });
    await page.goto('/connecteurs-mcp');
    await page.getByTestId(`mcp-apercu-${SOURCE}`).click();
    await expect(page.getByTestId(`mcp-tronque-${SOURCE}`)).toBeVisible();
  });

  test('🔴 un outil non activable dit POURQUOI, en nommant le paramètre', async ({ page }) => {
    await mock(page);
    await page.goto('/connecteurs-mcp');
    await page.getByTestId(`mcp-outils-${SOURCE}`).click();
    await expect(page.getByTestId('mcp-outil-non-activable-notion_creer')).toContainText('lignes');
  });

  test('🔴 chaque paramètre porte son choix de SOURCE : c’est là que se pose la garde d’identité', async ({ page }) => {
    // 🔴 Un outil MCP arrive avec TOUS ses paramètres remplis par le modèle, donc influençables par le
    // contact. Tant que le client n'a pas cloué l'identifiant à la fiche, un contact peut demander la
    // donnée de quelqu'un d'autre. C'est pour ça que l'écran montre chaque paramètre un par un.
    await mock(page);
    await page.goto('/connecteurs-mcp');
    await page.getByTestId(`mcp-outils-${SOURCE}`).click();
    await expect(page.getByTestId('mcp-source-client_id')).toBeVisible();
    await page.getByTestId('mcp-source-client_id').selectOption('champ');
    // Une LISTE, pas une saisie libre : proposer un champ libre revient a inviter la faute de frappe puis
    // a la refuser. Et elle est PRE-REMPLIE, donc un clic suffit.
    await expect(page.getByTestId('mcp-cle-client_id')).toHaveValue('email');
  });

  test('🔴 choisir « le numero du contact » pose un attribut, sinon l option est INERTE', async ({ page }) => {
    // 🔴 L executeur calcule `contactPath ?? name` : sans attribut, il chercherait `ctx.contact['client_id']`,
    // qui n existe pas, et enverrait `null`. Le client croirait avoir cloue l identifiant, l appel partirait
    // vide, et la reaction naturelle serait de repasser en « l agent decide ».
    await mock(page);
    await page.goto('/connecteurs-mcp');
    await page.getByTestId(`mcp-outils-${SOURCE}`).click();
    await page.getByTestId('mcp-source-client_id').selectOption('contact');
    await expect(page.getByTestId('mcp-contact-client_id')).toHaveValue('wa_id');
  });

  test('🔴 le RISQUE est propose par le serveur mais confirme par le client', async ({ page }) => {
    // La spec MCP declare les annotations d un outil NON FIABLES : sans ce selecteur, un serveur qui
    // s annonce « lecture seule » obtenait `risk: read` sans aucun acte humain.
    await mock(page);
    await page.goto('/connecteurs-mcp');
    await page.getByTestId(`mcp-outils-${SOURCE}`).click();
    await expect(page.getByTestId('mcp-risque-notion_search')).toHaveValue('read');
    await page.getByTestId('mcp-risque-notion_search').selectOption('irreversible');
    await expect(page.getByTestId('mcp-risque-notion_search')).toHaveValue('irreversible');
  });

  test('un paramètre obligatoire pour le serveur est signalé AU CLOUAGE', async ({ page }) => {
    // L'avertissement se pose au moment du choix, pas à l'appel : un champ vide part vide, et c'est le
    // serveur qui décide. Le client doit le savoir quand il décide, pas quand ça rate.
    await mock(page);
    await page.goto('/connecteurs-mcp');
    await page.getByTestId(`mcp-outils-${SOURCE}`).click();
    await expect(page.getByTestId('mcp-requis-q')).toBeVisible();
  });
});
