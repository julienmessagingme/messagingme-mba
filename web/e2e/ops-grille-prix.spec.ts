import { test, expect } from '@playwright/test';

/**
 * LA GRILLE DE PRIX SE REGLE DANS /ops, UNE FOIS, POUR TOUS LES ESPACES (lot 8 du 2026-09-23).
 *
 * 🔴 CE QUE CES TESTS PROTEGENT A L'ECRAN, et ce n'est pas le formulaire. C'est que la carte SE MASQUE
 * quand l'API n'a pas encore la route : la console part chez Vercel a chaque `git push` et l'API attend son
 * `up`, donc cette fenetre existe a CHAQUE livraison. Un formulaire de zeros y ferait croire que tout est
 * gratuit, et une erreur rouge ferait croire a une panne alors qu'il ne manque qu'un deploiement.
 *
 * ⚠️ ET QUE LA NOTE PART AVEC LES PRIX. Le jeton d'exploitation est PARTAGE : la note est la seule reponse a
 * « qui a change ce prix, et pourquoi ». Le serveur la refuse si elle manque, mais un ecran qui l'oublierait
 * rendrait ce refus incomprehensible.
 */
const OPS_TOKEN = 'ops-token-e2e';

const GRILLE = {
  margeTemplate: 120, serviceCentimes: 2.48, serviceFranchise: 1000,
  serviceDepuis: '2026-10-01', rcsSimpleCentimes: 6, rcsConversationnelCentimes: 8,
};

const OVERVIEW = {
  tenants: [{
    id: 't-client', name: 'Client Démo', createdAt: '2026-01-01T00:00:00Z', mbaEnabled: false,
    users: 1, contacts: 0, messages: 0, templatesUsed: 0, lastSendAt: null,
    phone: null, phoneStatus: null, quality: null,
  }],
  daily: [], queues: [], worker: null,
};

/** `prix: null` = la route n'existe pas encore sur cette API (fenetre Vercel / VPS). */
async function monter(page: import('@playwright/test').Page, prix: typeof GRILLE | null) {
  const patches: unknown[] = [];
  await page.addInitScript((tok) => window.localStorage.setItem('mba.ops', tok), OPS_TOKEN);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = route.request().url().split('?')[0]!;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/ops/prix')) {
      if (prix === null) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"indisponible"}' });
      if (route.request().method() === 'PATCH') {
        const corps = route.request().postDataJSON() as Record<string, unknown>;
        patches.push(corps);
        // Le serveur NOMME le champ fautif plutot que de corriger la valeur.
        if (typeof corps.serviceCentimes === 'number' && corps.serviceCentimes > 100) {
          return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"champ invalide : serviceCentimes","champ":"serviceCentimes"}' });
        }
        return json({ prix: corps });
      }
      return json({ prix, bornes: { margeTemplate: { min: 1, max: 1000 } } });
    }
    if (chemin.endsWith('/ops/overview')) return json(OVERVIEW);
    return json({});
  });
  await page.goto('/ops');
  return patches;
}

test.describe('Ops : la grille de prix', () => {
  test('la carte montre les prix du serveur, jamais des valeurs inventées', async ({ page }) => {
    await monter(page, GRILLE);
    await expect(page.getByTestId('ops-prix')).toBeVisible();
    await expect(page.getByTestId('prix-marge')).toHaveValue('120');
    await expect(page.getByTestId('prix-rcsconv')).toHaveValue('8');
  });

  test('🔴 API sans la route -> la carte le DIT et n’offre aucun formulaire', async ({ page }) => {
    // La fenêtre Vercel / VPS existe à chaque livraison : un formulaire de zéros y ferait croire que tout
    // est gratuit, et un opérateur enregistrerait des prix nuls pour tous les espaces.
    await monter(page, null);
    await expect(page.getByTestId('ops-prix')).toHaveCount(0);
    await expect(page.getByTestId('prix-marge')).toHaveCount(0);
    await expect(page.getByText(/Indisponible sur cette instance/)).toBeVisible();
  });

  test('🔴 enregistrer envoie les SIX champs ET la note', async ({ page }) => {
    const patches = await monter(page, GRILLE);
    await page.getByTestId('prix-marge').fill('135');
    await page.getByTestId('ops-prix-note').fill('grille 2027');
    await page.getByTestId('ops-prix-enregistrer').click();
    await expect(page.getByTestId('ops-prix-ok')).toBeVisible();
    expect(patches).toHaveLength(1);
    // La note voyage AVEC les prix : c'est la seule trace de qui a changé quoi.
    expect(patches[0]).toEqual({ ...GRILLE, margeTemplate: 135, note: 'grille 2027' });
  });

  test('🔴 un refus du serveur NOMME le champ, et rien n’affiche « enregistré »', async ({ page }) => {
    await monter(page, GRILLE);
    await page.getByTestId('prix-service').fill('248');
    await page.getByTestId('ops-prix-note').fill('essai');
    await page.getByTestId('ops-prix-enregistrer').click();
    await expect(page.getByTestId('ops-prix-erreur')).toBeVisible();
    await expect(page.getByTestId('ops-prix-ok')).toHaveCount(0);
    // Le champ fautif porte le liseré rouge : sans lui, il faut chercher lequel des six ne va pas.
    await expect(page.getByTestId('prix-service')).toHaveClass(/border-red-400/);
  });

  test('⚠️ la saisie reste du TEXTE tant qu’on tape : un séparateur décimal survit', async ({ page }) => {
    // Le défaut d'origine : convertir à chaque frappe rendait `Number('3.') === 3`, donc le point
    // disparaissait et on ne pouvait JAMAIS écrire 3,10.
    await monter(page, GRILLE);
    await page.getByTestId('prix-service').fill('3.');
    await expect(page.getByTestId('prix-service')).toHaveValue('3.');
    await page.getByTestId('prix-service').fill('');
    await expect(page.getByTestId('prix-service'), 'vider ne doit pas remplir de zéro tout seul').toHaveValue('');
  });
});
