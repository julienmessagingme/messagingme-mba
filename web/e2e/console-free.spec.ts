import { test, expect, type Page } from './aide/test';

/**
 * LA CONSOLE D'UNE FREE (spec offres v2, livraison 3). La Free se pilote depuis Claude Code, Cursor ou l'API : la console
 * ne lui garde que l'accueil (le numéro, et les trois gestes pour piloter l'espace), les clés, la doc, l'offre, le compte
 * et le support. Ce que ces tests tiennent à l'écran : l'accueil d'une Free sans indicateurs ni lecture des réglages ou des
 * statistiques (le serveur les lui refuse), un écran fermé remplacé par l'encart qui renvoie vers l'accueil, la barre
 * grisée qui mène à l'offre, et un Pro qui garde tout. Le serveur, lui, est tenu par `tests/offres-fonctions.test.ts`.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const TOUTES = ['inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'analyse', 'publicites', 'email', 'chaines', 'crm', 'rcs', 'performance_lab', 'console'];
// Le Pro resserré (spec offres v2, livraison 5) : sans l'analyse, les publicités ni les chaînes.
const PRO = ['inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'email', 'console'];
const limites = (o: 'free' | 'pro' | 'entreprise') => ({
  utilisateurs: o === 'free' ? 1 : o === 'pro' ? 3 : null, admins: o === 'free' ? 1 : o === 'pro' ? 2 : null,
  contacts: o === 'free' ? 100 : null, envoisModelesMois: o === 'free' ? 1000 : null, automations: o === 'free' ? 10 : null,
  suppressionsJour: o === 'free' ? 10 : null, adressesWebhook: o === 'free' ? 1 : 5, journalWebhooksJours: o === 'free' ? 3 : 30,
  conservationJours: o === 'free' ? 30 : 90, commissionPct: o === 'free' ? 50 : 10, badge: o === 'free', numeroInclus: o !== 'free',
});
const GRILLE = {
  free: { fonctions: [], limites: limites('free') },
  pro: { fonctions: PRO, limites: limites('pro') },
  entreprise: { fonctions: TOUTES, limites: limites('entreprise') },
};
const vue = (o: 'free' | 'pro') => ({
  offre: o, fonctions: GRILLE[o].fonctions, limites: limites(o),
  usage: { envoisModelesMois: 0, contacts: 0, automations: 0, membres: 1 }, grille: GRILLE, upgradeUrl: 'https://console.e2e.test/offre',
});

async function monter(page: Page, offre: 'free' | 'pro'): Promise<string[]> {
  const appels: string[] = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname.replace('/api/backend', '');
    appels.push(`${req.method()} ${chemin}`);
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/offre')) return json(vue(offre));
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Admin', role: 'admin' });
    if (chemin.endsWith('/account-status')) return json({ hasNumber: false });
    return json({});
  });
  return appels;
}

test.describe('La console d’une Free', () => {
  test('🔴 l’accueil d’une Free : le numéro et les trois gestes Claude Code, ni indicateurs ni réglages ni statistiques', async ({ page }) => {
    const appels = await monter(page, 'free');
    await page.goto('/accueil');
    await expect(page.getByTestId('accueil-free')).toBeVisible();
    await expect(page.getByTestId('demarrer-commande-1')).toBeVisible();
    await expect(page.getByTestId('demarrer-creer-cle')).toBeVisible();
    await expect(page.getByTestId('demarrer-lancement')).toBeVisible();
    await expect(page.getByTestId('accueil-free-lien-pro')).toHaveAttribute('href', '/offre?fonction=console');
    await expect(page.getByText('30 derniers jours')).toHaveCount(0);
    // Le serveur refuse ces lectures à une Free : l'écran ne doit même pas les tenter.
    expect(appels.filter((a) => /\/settings|\/stats|\/accueil\/volumes|\/phone-numbers|\/repondeur/.test(a))).toEqual([]);
  });

  test('🔴 chaque écran d’une Free n’appelle que des routes que le serveur lui garde (MODULES_OUVERTS_AU_FREE)', async ({ page }) => {
    // Les routes d'espace ouvertes à la Free (`src/server.ts`), en chemins relatifs à l'espace. Un appel ajouté demain à
    // l'un de ces écrans vers une autre route casserait en silence après le déploiement de l'API : ce test le voit.
    const OUVERTES = [
      /^GET \/offre$/, /^(POST|PUT) \/offre\/(paiement|portail|numero)$/, /^GET \/abonnement-numero$/, /^GET \/me$/,
      /^GET \/espaces$/, /^POST \/changer-espace$/, /^(GET|PUT) \/moi\/emails$/, /^GET \/account-status$/, /^GET \/nom$/,
      /^(GET|POST) \/embedded-signup\//, /^(GET|POST) \/numero\//, /^POST \/360dialog\//, /^(GET|POST) \/numero-fourni/,
      /^GET \/connexion-numero$/, /^(GET|POST|DELETE) \/api-keys/, /^(GET|DELETE|POST) \/oauth\/(autorisations|autoriser)/,
      /^POST \/support$/, /^POST \/credit\/paiement$/,
    ];
    const appels = await monter(page, 'free');
    for (const ecran of ['/accueil', '/connecter-whatsapp', '/demarrer', '/developers/keys', '/developers/mcp', '/offre', '/compte', '/support']) {
      await page.goto(ecran);
      await page.waitForLoadState('networkidle');
    }
    const espace = appels
      .map((a) => a.match(/^(\w+) \/tenants\/t-e2e(\/.*)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => `${m[1]} ${m[2]}`);
    expect(espace.length).toBeGreaterThan(0);
    expect(espace.filter((a) => !OUVERTES.some((r) => r.test(a)))).toEqual([]);
  });

  test('🔴 un écran fermé : l’encart de la console renvoie vers l’accueil et vers l’offre', async ({ page }) => {
    await monter(page, 'free');
    await page.goto('/contacts');
    await expect(page.getByTestId('encart-offre')).toBeVisible();
    await expect(page.getByTestId('encart-offre-console')).toBeVisible();
    await expect(page.getByTestId('encart-offre-accueil')).toHaveAttribute('href', '/accueil');
    await expect(page.getByTestId('encart-offre-lien')).toHaveAttribute('href', '/offre?fonction=console');
  });

  test('🔴 une recharge du crédit payée depuis Claude revient sur la page publique, qui parle du crédit', async ({ page }) => {
    // La page Crédit IA est fermée à la Free : `buy_credit` renvoie ici (`?produit=credit`), sans session.
    await page.goto('/paiement-recu?produit=credit');
    await expect(page.getByTestId('paiement-recu')).toContainText('recharge de votre crédit IA');
    await page.goto('/paiement-recu?produit=credit&abonnement=abandon');
    await expect(page.getByTestId('paiement-abandonne')).toBeVisible();
  });

  test('un Pro garde la console : ni encart ni accueil réduit', async ({ page }) => {
    await monter(page, 'pro');
    await page.goto('/accueil');
    await expect(page.getByText('30 derniers jours')).toBeVisible();
    await expect(page.getByTestId('accueil-free')).toHaveCount(0);
    await page.goto('/contacts');
    await expect(page.getByTestId('encart-offre')).toHaveCount(0);
  });
});
