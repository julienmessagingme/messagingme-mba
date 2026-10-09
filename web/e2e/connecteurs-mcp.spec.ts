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

async function mock(page: Page, over: { plan?: unknown; tronque?: boolean; aucun?: boolean; apercuRefuse?: string; serveur?: Record<string, unknown>; outils?: unknown[]; proposeRefuse?: string } = {}): Promise<Array<{ method: string; url: string }>> {
  const appels: Array<{ method: string; url: string }> = [];
  // Mutable comme en base : un aperçu réussi pose `lastOkAt`, que la carte doit relire.
  let lastOkAt: string | null = null;
  // Comme en base : l'import pose les outils, que la carte relit ensuite.
  let outilsCourants: unknown[] = over.outils ?? OUTILS;
  await page.addInitScript((s) => {
    window.localStorage.setItem('mba.session', JSON.stringify(s));
  }, SESSION);
  await page.route('**/api/backend/**', async (route: Route) => {
    const url = route.request().url();
    const method = route.request().method();
    appels.push({ method, url });
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/propose')) {
      if (over.proposeRefuse) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: over.proposeRefuse }) });
      return json({ propose: false });
    }
    if (url.includes('/mcp/') && url.endsWith('/outils')) {
      // Les deux listes de clouage viennent du SERVEUR : l ecran ne les recopie pas.
      return json({ outils: outilsCourants, champs: ['email', 'reference'], champsContact: ['wa_id', 'nom'] });
    }
    if (url.endsWith(`/tenants/${TENANT}/mcp`) && method === 'POST') {
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ serveur: SERVEUR }) });
    }
    if (url.endsWith(`/tenants/${TENANT}/mcp`)) return json({ serveurs: over.aucun ? [] : [{ ...SERVEUR, lastOkAt, ...over.serveur }] });
    if (url.includes('/apercu') && over.apercuRefuse) {
      return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: over.apercuRefuse }) });
    }
    if (url.includes('/apercu')) {
      // Le vrai serveur marque la réponse pendant l'aperçu (`calculer`).
      lastOkAt = '2026-10-02T12:00:00Z';
      return json({
        plan: over.plan ?? [{ type: 'schema_change', nom: 'search', consentementsTombes: 2 }],
        tronque: over.tronque ?? false,
      });
    }
    if (url.includes('/importer')) { outilsCourants = OUTILS; return json({ plan: [], tronque: false }); }
    return json({});
  });
  return appels;
}

test.describe('Tools > Connecteurs MCP', () => {
  test('🔴 l’écran DIT où l’agent de Meta reçoit ces outils', async ({ page }) => {
    await mock(page);
    await page.goto('/connecteurs-mcp');
    await expect(page.getByTestId('mcp-note-mba')).toBeVisible();
    await expect(page.getByTestId('mcp-note-mba')).toContainText('AI Agent > MBA, onglet Outils');
  });

  test('🔴 reconnecter ce qui ferait PERDRE un outil à un agent se fait confirmer, et rien n’est importé avant', async ({ page }) => {
    // 🔴 Un rafraîchissement peut faire tomber des consentements : écraser n'est acceptable que si l'on
    // montre quoi avant de le faire. C'est la seule confirmation que « Connecter » garde.
    const appels = await mock(page);
    await page.goto('/connecteurs-mcp');
    await page.getByTestId(`mcp-connecter-${SOURCE}`).click();
    await expect(page.getByTestId(`mcp-plan-${SOURCE}`)).toContainText('search');
    await expect(page.getByTestId(`mcp-plan-${SOURCE}`)).toContainText('2 agent(s)');
    expect(appels.filter((a) => a.url.includes('/importer'))).toHaveLength(0);
    await page.getByTestId(`mcp-importer-${SOURCE}`).click();
    await expect.poll(() => appels.filter((a) => a.url.includes('/importer')).length).toBe(1);
    await expect(page.getByTestId(`mcp-plan-${SOURCE}`)).toHaveCount(0);
  });

  test('🔴 un serveur qui refuse l’aperçu : l’écran montre la RAISON du serveur, pas « Erreur 422 »', async ({ page }) => {
    // 🔴 La route rend 422, jamais 5xx : Cloudflare remplace le corps de tout 5xx, et l'administrateur ne
    // lisait plus que « Erreur 502 » pour une cause que le serveur connaissait. Ce cas tient l'autre moitié :
    // un 422 n'est PAS un statut que l'écran ignore, sa raison arrive telle quelle.
    await mock(page, { apercuRefuse: 'le serveur a refusé la connexion (401)' });
    await page.goto('/connecteurs-mcp');
    await page.getByTestId(`mcp-connecter-${SOURCE}`).click();
    await expect(page.getByTestId('mcp-erreur')).toHaveText('le serveur a refusé la connexion (401)');
    await expect(page.getByTestId(`mcp-plan-${SOURCE}`)).toHaveCount(0);
  });

  test('🔴 un catalogue TRONQUÉ prévient que rien n’a été retiré', async ({ page }) => {
    // Le client doit savoir que la liste est partielle ET ce que ça implique : sur un catalogue tronqué,
    // l'import n'enlève rien, sinon il débrancherait tout ce qui vit au delà de la borne.
    await mock(page, { tronque: true, plan: [{ type: 'nouveau', nom: 'search' }] });
    await page.goto('/connecteurs-mcp');
    await page.getByTestId(`mcp-connecter-${SOURCE}`).click();
    await expect(page.getByTestId(`mcp-tronque-${SOURCE}`)).toBeVisible();
  });

  test('🔴 un outil non activable dit POURQUOI, en nommant le paramètre', async ({ page }) => {
    await mock(page);
    await page.goto('/connecteurs-mcp');
    // Replié, la ligne le dit déjà ; déplié, la raison complète.
    await expect(page.getByTestId('mcp-etat-outil-notion_creer')).toContainText(/inutilisable|unusable/);
    await page.getByTestId('mcp-deplier-notion_creer').click();
    await expect(page.getByTestId('mcp-outil-non-activable-notion_creer')).toContainText('lignes');
  });

  test('🔴 chaque paramètre porte son choix de SOURCE : c’est là que se pose la garde d’identité', async ({ page }) => {
    // 🔴 Un outil MCP arrive avec TOUS ses paramètres remplis par le modèle, donc influençables par le
    // contact. Tant que le client n'a pas cloué l'identifiant à la fiche, un contact peut demander la
    // donnée de quelqu'un d'autre. C'est pour ça que l'écran montre chaque paramètre un par un.
    await mock(page);
    await page.goto('/connecteurs-mcp');
    await page.getByTestId('mcp-deplier-notion_search').click();
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
    await page.getByTestId('mcp-deplier-notion_search').click();
    await page.getByTestId('mcp-source-client_id').selectOption('contact');
    await expect(page.getByTestId('mcp-contact-client_id')).toHaveValue('wa_id');
  });

  test('🔴 le RISQUE est propose par le serveur mais confirme par le client', async ({ page }) => {
    // La spec MCP declare les annotations d un outil NON FIABLES : sans ce selecteur, un serveur qui
    // s annonce « lecture seule » obtenait `risk: read` sans aucun acte humain.
    await mock(page);
    await page.goto('/connecteurs-mcp');
    await page.getByTestId('mcp-deplier-notion_search').click();
    await expect(page.getByTestId('mcp-risque-notion_search')).toHaveValue('read');
    await page.getByTestId('mcp-risque-notion_search').selectOption('irreversible');
    await expect(page.getByTestId('mcp-risque-notion_search')).toHaveValue('irreversible');
  });

  test('🔴 « quand NE PAS l appeler » EXISTE a l ecran et PART dans le PATCH', async ({ page }) => {
    // La route l acceptait depuis le premier jour et l import le posait a vide en disant « c est au client
    // de l ecrire » : aucun ecran ne le lui demandait, donc il restait vide pour toujours. C est le motif
    // « offert-et-inerte » que ce produit s interdit ailleurs (migration 0144).
    let corps: unknown = null;
    await mock(page);
    await page.route('**/api/backend/**/mcp/outils/**', async (route: Route) => {
      corps = JSON.parse(route.request().postData() ?? '{}');
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.goto('/connecteurs-mcp');
    await page.getByTestId('mcp-deplier-notion_search').click();
    await page.getByTestId('mcp-nepasutiliser-notion_search').fill('jamais sans numero de commande');
    await page.getByTestId('mcp-enregistrer-notion_search').click();
    await expect(page.getByTestId('mcp-reglage-ok-notion_search')).toBeVisible();
    expect(corps).toMatchObject({ nePasUtiliser: 'jamais sans numero de commande' });
  });

  test('un paramètre obligatoire pour le serveur est signalé AU CLOUAGE', async ({ page }) => {
    // L'avertissement se pose au moment du choix, pas à l'appel : un champ vide part vide, et c'est le
    // serveur qui décide. Le client doit le savoir quand il décide, pas quand ça rate.
    await mock(page);
    await page.goto('/connecteurs-mcp');
    await page.getByTestId('mcp-deplier-notion_search').click();
    await expect(page.getByTestId('mcp-requis-q')).toBeVisible();
  });
});

test.describe('declarer un serveur MCP', () => {
  test('🔴 le formulaire EXISTE, et l ecran vide y renvoie', async ({ page }) => {
    // 🔴 SANS LUI, TOUT L ECRAN EST INUTILISABLE. Le formulaire des connecteurs API ecrit « type HTTP » en
    // dur : tant que cette route n existait pas, la liste restait vide pour toujours, et le seul texte que
    // voyait le client renvoyait vers un « type MCP » qui n existe nulle part.
    const appels = await mock(page, { aucun: true });
    await page.goto('/connecteurs-mcp');
    await expect(page.getByTestId('mcp-vide')).toContainText('bouton ci-dessus');
    await expect(page.getByTestId('mcp-vide')).not.toContainText('Connecteurs API');

    await page.getByTestId('mcp-declarer-ouvrir').click();
    await page.getByTestId('mcp-neuf-label').fill('Notion');
    await page.getByTestId('mcp-neuf-url').fill('https://exemple.test/mcp');
    await page.getByTestId('mcp-neuf-secret').fill('jeton-du-client');
    await page.getByTestId('mcp-neuf-creer').click();

    await expect.poll(() => appels.filter((a) => a.method === 'POST' && a.url.endsWith('/mcp')).length).toBe(1);
  });

  test('le nom de l en-tete n apparait que pour le mode qui en a besoin', async ({ page }) => {
    await mock(page, { aucun: true });
    await page.goto('/connecteurs-mcp');
    await page.getByTestId('mcp-declarer-ouvrir').click();
    await expect(page.getByTestId('mcp-neuf-entete')).toHaveCount(0);
    await page.getByTestId('mcp-neuf-auth').selectOption('header');
    await expect(page.getByTestId('mcp-neuf-entete')).toBeVisible();
    // Et le jeton disparait quand il n y a pas d authentification.
    await page.getByTestId('mcp-neuf-auth').selectOption('none');
    await expect(page.getByTestId('mcp-neuf-secret')).toHaveCount(0);
  });
  test('🔴 « Connecter » relit la carte : elle ne dit plus « Jamais connecté » après une connexion', async ({ page }) => {
    await mock(page, { plan: [{ type: 'inchange', nom: 'search' }] });
    await page.goto('/connecteurs-mcp');
    const carte = page.getByTestId(`mcp-serveur-${SOURCE}`);
    await expect(carte).toContainText(/Jamais connecté|Never connected/);
    await page.getByTestId(`mcp-connecter-${SOURCE}`).click();
    await expect(carte).toContainText(/Connecté le|Connected on/);
    await expect(carte).not.toContainText(/Jamais connecté|Never connected/);
  });

  test('un serveur en brouillon le dit en mots', async ({ page }) => {
    await mock(page, { serveur: { status: 'draft' } });
    await page.goto('/connecteurs-mcp');
    await expect(page.getByTestId(`mcp-statut-${SOURCE}`)).toContainText(/connecté|connected/);
    await expect(page.getByTestId(`mcp-serveur-${SOURCE}`)).not.toContainText('draft');
  });
  test('🔴 les outils importés se voient SANS clic, avec à qui ils sont donnés', async ({ page }) => {
    await mock(page, { outils: [{ ...OUTILS[0], propose: true, utilisePar: ['Agent de Meta'] }] });
    await page.goto('/connecteurs-mcp');
    await expect(page.getByTestId('mcp-outil-notion_search')).toBeVisible();
    await expect(page.getByTestId('mcp-utilise-par-notion_search')).toContainText('Agent de Meta');
    await expect(page.getByTestId(`mcp-connecter-${SOURCE}`)).toHaveText(/Connecter|Connect/);
  });

  test('🔴 « Désenregistrer » part en PUT ; un refus nomme les agents', async ({ page }) => {
    const appels = await mock(page, { outils: [{ ...OUTILS[0], propose: true, utilisePar: [] }] });
    await page.goto('/connecteurs-mcp');
    await page.getByTestId('mcp-propose-notion_search').click();
    await expect.poll(() => appels.filter((a) => a.method === 'PUT' && a.url.endsWith('/outils/o1/propose')).length).toBe(1);

    const refus = 'utilisé par Agent de Meta : retirez-le d’abord de cet agent';
    await mock(page, { outils: [{ ...OUTILS[0], propose: true, utilisePar: ['Agent de Meta'] }], proposeRefuse: refus });
    await page.goto('/connecteurs-mcp');
    await page.getByTestId('mcp-propose-notion_search').click();
    await expect(page.getByTestId('mcp-reglage-erreur-notion_search')).toContainText('Agent de Meta');
  });

  test('🔴 « Connecter » importe d’un geste : les outils apparaissent juste dessous, sans autre bouton', async ({ page }) => {
    // Julien, 2026-10-02 : « quand tu connectes, je veux la liste des outils juste en dessous ».
    const appels = await mock(page, { outils: [], plan: [{ type: 'nouveau', nom: 'search' }, { type: 'nouveau', nom: 'creer' }] });
    await page.goto('/connecteurs-mcp');
    await expect(page.getByTestId(`mcp-liste-outils-${SOURCE}`)).toContainText(/Connecter|Connect/);
    await page.getByTestId(`mcp-connecter-${SOURCE}`).click();
    await expect(page.getByTestId('mcp-outil-notion_search')).toBeVisible();
    await expect(page.getByTestId(`mcp-connecte-${SOURCE}`)).toContainText('2 outil');
    expect(appels.filter((a) => a.url.includes('/importer'))).toHaveLength(1);
    await expect(page.getByTestId(`mcp-plan-${SOURCE}`)).toHaveCount(0);
  });
  test('🔴 chaque outil est une ligne repliée : nom, état, bouton ; le détail se déplie', async ({ page }) => {
    // Julien, 2026-10-02 : « ça évitera que ce soit illisible s'il y a 30 outils ».
    await mock(page, { outils: [{ ...OUTILS[0], propose: true, utilisePar: [] }] });
    await page.goto('/connecteurs-mcp');
    await expect(page.getByTestId('mcp-etat-outil-notion_search')).toHaveText(/Enregistré|Registered/);
    await expect(page.getByTestId('mcp-propose-notion_search')).toHaveText(/Désenregistrer|Unregister/);
    await expect(page.getByTestId('mcp-detail-notion_search')).toHaveCount(0);
    await page.getByTestId('mcp-deplier-notion_search').click();
    await expect(page.getByTestId('mcp-detail-notion_search')).toBeVisible();
    await expect(page.getByTestId('mcp-deplier-notion_search')).toHaveAttribute('aria-expanded', 'true');
  });

  test('🔴 action groupée : tout cocher puis « Désenregistrer » ; un refus se dit pour CET outil, les autres passent', async ({ page }) => {
    const deux = [{ ...OUTILS[0], propose: true, utilisePar: [] }, { ...OUTILS[1], propose: true, utilisePar: [] }];
    const appels = await mock(page, { outils: deux });
    await page.goto('/connecteurs-mcp');
    await expect(page.getByTestId(`mcp-groupe-desenregistrer-${SOURCE}`)).toBeDisabled();
    await page.getByTestId(`mcp-tout-${SOURCE}`).check();
    await expect(page.getByTestId(`mcp-coches-${SOURCE}`)).toContainText('2');
    await page.getByTestId(`mcp-groupe-desenregistrer-${SOURCE}`).click();
    await expect.poll(() => appels.filter((a) => a.method === 'PUT' && a.url.endsWith('/propose')).length).toBe(2);
    await expect(page.getByTestId(`mcp-bilan-${SOURCE}`)).toContainText('2');

    // Un refus, nommé, sans empêcher l'autre.
    await page.route('**/api/backend/**/mcp/outils/o1/propose', (route: Route) => route.fulfill({
      status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'utilisé par Agent de Meta : retirez-le d’abord de cet agent' }),
    }));
    await page.getByTestId('mcp-selection-notion_search').check();
    await page.getByTestId('mcp-selection-notion_creer').check();
    await page.getByTestId(`mcp-groupe-desenregistrer-${SOURCE}`).click();
    await expect(page.getByTestId(`mcp-bilan-${SOURCE}`)).toContainText('Agent de Meta');
    await expect(page.getByTestId(`mcp-bilan-${SOURCE}`)).toContainText(/1 outil/);
  });
});
