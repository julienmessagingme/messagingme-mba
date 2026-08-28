import { test, expect } from '@playwright/test';

/**
 * BRANCHER LE SYSTÈME DU CLIENT (lot L2) : déclarer une source, l'éprouver, y poser un outil.
 *
 * 🔴 CE QUE SEUL UN TEST DE BOUT EN BOUT VOIT ICI :
 *  - la section des connecteurs est SÉPARÉE du catalogue maison (le client ne doit pas confondre ce qu'on
 *    garantit et ce qu'il branche lui-même) ;
 *  - le secret saisi part au serveur mais n'est JAMAIS réaffiché ;
 *  - l'outil déclaré porte son gabarit, ses champs de sortie et le fait qu'il naît INACTIF ;
 *  - l'épreuve rend un verdict lisible, y compris quand elle échoue.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const AG = '11111111-1111-4111-8111-111111111111';
const SRC = '22222222-2222-4222-8222-222222222222';

const SOURCE = {
  id: SRC, kind: 'http', label: 'ERP', baseUrl: 'https://api.client.fr/v1',
  authKind: 'bearer', authHeaderName: null, aAuthentification: true,
  status: 'active', lastOkAt: null, lastError: null, outilsActifs: 0,
};

const AGENT = {
  id: AG, label: 'Support', status: 'draft', mentionIa: 'Vous échangez avec un assistant automatique.',
  modele: 'zai/glm-4.7-flash', ficheVersion: 1,
  contenu: { nom: '', objectif: 'Aider', ton: '', personnalite: '', reglesTransfert: '', sorties: [] },
  plafonds: { maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30000 },
  inactiviteMinutes: 30, contactInconnu: 'lecture_seule',
};

async function mock(page: import('@playwright/test').Page, capture: { posts: Array<{ url: string; body: unknown }> }, over: { sources?: unknown[]; outils?: unknown[]; epreuve?: unknown } = {}) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' || req.method() === 'PATCH' || req.method() === 'DELETE') {
      capture.posts.push({ url, body: req.postDataJSON() ?? null });
      if (url.includes('/epreuve')) return json(over.epreuve ?? { ok: true, httpStatus: 200 });
      if (url.includes('/agent-sources')) {
        // La source créée entre dans la liste : c'est ce qui permet de vérifier qu'à la relecture, le champ
        // du secret est VIDE. Le serveur ne le renvoie jamais.
        (over.sources as unknown[] | undefined)?.push(SOURCE);
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ source: SOURCE }) });
      }
      if (url.includes('/tools/connecteur')) {
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ outil: { id: 'o9', origin: 'http', sourceId: SRC, name: 'lire_commande', title: 'Lire', description: 'd', nePasUtiliser: 'n', params: [], binding: { methode: 'GET', chemin: '/commandes/{ref}' }, risk: 'read', actif: false, activeLe: null, autonome: false, autonomeLe: null, expose: null } }) });
      }
      return json({ ok: true });
    }
    if (url.includes('/agent-sources')) return json({ sources: over.sources ?? [SOURCE] });
    if (/\/agents\/[^/]+\/tools$/.test(url)) return json({ outils: over.outils ?? [], catalogue: [] });
    if (/\/agents\/[^/]+$/.test(url)) return json({ agent: AGENT });
    if (url.endsWith('/agents')) return json({ agents: [{ id: AG, label: 'Support', status: 'draft' }] });
    if (url.includes('/agents/solde')) return json({ soldeMicroEur: 10_000_000 });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.includes('/settings')) return json({ mbaEnabled: false, rcsEnabled: false, hubspotListsEnabled: false, campaignsPaused: false });
    return json({});
  });
  await page.goto(`/agents?id=${AG}&tab=outils`);
}

/** L'onglet Outils est ouvert par l'URL (`?id=...&tab=outils`), comme dans `agents-outils.spec.ts`. */
async function ongletOutils(page: import('@playwright/test').Page) {
  await expect(page.getByTestId('source-creer')).toBeVisible();
}

test.describe('Agent : brancher le système du client', () => {
  test('🔴 déclare une source, et le secret ne revient JAMAIS à l’écran', async ({ page }) => {
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture, { sources: [] });
    await ongletOutils(page);

    await page.getByTestId('source-label').fill('ERP');
    await page.getByTestId('source-url').fill('https://api.client.fr/v1');
    await page.getByTestId('source-secret').fill('jeton-tres-secret');
    await page.getByTestId('source-creer').click();

    await expect.poll(() => capture.posts.some((p) => p.url.includes('/agent-sources'))).toBe(true);
    const envoi = capture.posts.find((p) => p.url.includes('/agent-sources'))!;
    expect(envoi.body).toMatchObject({ label: 'ERP', baseUrl: 'https://api.client.fr/v1', authKind: 'bearer', authSecret: 'jeton-tres-secret' });
    // La source relue ne porte pas le secret : l'écran ne peut donc pas le réafficher.
    await expect(page.getByTestId(`source-secret-${SRC}`)).toHaveValue('');
  });

  test('🔴 l’épreuve dit ce qui s’est passé, y compris quand elle ÉCHOUE', async ({ page }) => {
    // Un jeton expiré ne produit aucune erreur applicative : sans cet écran, l'agent dégraderait en silence
    // au milieu d'une conversation.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture, { epreuve: { ok: false, httpStatus: 401, erreur: 'authentification refusée' } });
    await ongletOutils(page);
    await page.getByTestId(`source-eprouver-${SRC}`).click();
    await expect(page.getByTestId(`source-epreuve-${SRC}`)).toContainText(/authentification/i);
  });

  test('🔴 déclarer un outil : gabarit, champs lus, et il naît INACTIF', async ({ page }) => {
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture);
    await ongletOutils(page);

    await page.getByTestId(`source-nouvel-outil-${SRC}`).click();
    await page.getByTestId('outil-nom').fill('lire_commande');
    await page.getByTestId('outil-titre').fill('Lire une commande');
    await page.getByTestId('outil-chemin').fill('/commandes/{ref}');
    await page.getByTestId('outil-description').fill('Quand le client demande où en est sa commande.');
    await page.getByTestId('outil-champs').fill('statut\nlivraison.date');
    await page.getByTestId('param-ajouter').click();
    await page.getByTestId('param-nom-0').fill('ref');
    await page.getByTestId('outil-creer').click();

    await expect.poll(() => capture.posts.some((p) => p.url.includes('/tools/connecteur'))).toBe(true);
    const envoi = capture.posts.find((p) => p.url.includes('/tools/connecteur'))!;
    expect(envoi.body).toMatchObject({
      sourceId: SRC, name: 'lire_commande', methode: 'GET', chemin: '/commandes/{ref}',
      outputPaths: ['statut', 'livraison.date'],
      params: [{ name: 'ref', source: 'modele' }],
    });
  });

  test('🔴 un paramètre « le contact » se déclare, et l’écran dit qu’il ne vient pas de l’agent', async ({ page }) => {
    // C'est la garde anti-IDOR du lot : elle doit être LISIBLE par le client, pas seulement vraie dans le code.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture);
    await ongletOutils(page);
    await page.getByTestId(`source-nouvel-outil-${SRC}`).click();
    await expect(page.getByText(/ne peut pas être fabriqué par l’agent|cannot be forged by the agent/)).toBeVisible();

    await page.getByTestId('outil-nom').fill('mes_commandes');
    await page.getByTestId('outil-titre').fill('Mes commandes');
    await page.getByTestId('outil-chemin').fill('/clients/{tel}/commandes');
    await page.getByTestId('outil-description').fill('Les commandes du client qui écrit.');
    await page.getByTestId('outil-champs').fill('commandes');
    await page.getByTestId('param-ajouter').click();
    await page.getByTestId('param-nom-0').fill('tel');
    await page.getByTestId('param-source-0').selectOption('contact');
    await page.getByTestId('outil-creer').click();

    await expect.poll(() => capture.posts.some((p) => p.url.includes('/tools/connecteur'))).toBe(true);
    const envoi = capture.posts.find((p) => p.url.includes('/tools/connecteur'))!;
    expect(envoi.body).toMatchObject({ params: [{ name: 'tel', source: 'contact', contactPath: 'wa_id' }] });
  });

  test('sans champ à lire, le bouton reste inactif : le filtre de sortie est obligatoire', async ({ page }) => {
    // La réponse du système du client part chez le fournisseur du modèle : quelqu'un doit décider ce qui
    // traverse, et c'est ici.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture);
    await ongletOutils(page);
    await page.getByTestId(`source-nouvel-outil-${SRC}`).click();
    await page.getByTestId('outil-nom').fill('x_test');
    await page.getByTestId('outil-titre').fill('X');
    await page.getByTestId('outil-description').fill('d');
    await expect(page.getByTestId('outil-creer')).toBeDisabled();
    await page.getByTestId('outil-champs').fill('statut');
    await expect(page.getByTestId('outil-creer')).toBeEnabled();
  });
});
