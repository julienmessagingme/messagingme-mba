import { test, expect, type Page } from '@playwright/test';
import { TREIZE_POUCES, pasDeDebordement, pasDeChevauchement } from './aide/largeur';

/**
 * E2E de l'assistant de campagne, étapes Nom et Canal.
 *
 * Ce que ces specs protègent, et qu'aucun test unitaire ne peut voir :
 *
 *  1. 🔴 LA LARGEUR SUR UN 13 POUCES. C'est la demande explicite de Julien (2026-09-12), et elle n'est
 *     vérifiable que dans un vrai navigateur, à une taille de fenêtre FIXÉE. Un test qui ne la fixe pas
 *     mesure l'écran de la machine qui l'exécute : il passe chez nous et rate chez le client.
 *  2. 🔴 LE NOM ACCESSIBLE DES COMMANDES. « WhatsApp », « WhatsApp et RCS, avec repli » et « WhatsApp en
 *     premier » se contiennent l'un l'autre : c'est le genre de collision qui ne se voit qu'en
 *     interrogeant le DOM rendu, et qui rend un écran impilotable au clavier comme au test.
 *  3. Les conditions d'apparition (le repli ouvre deux sous-questions, le rattrapage n'apparaît que
 *     quand quelque chose peut le déclencher), qui sont des règles de rendu, pas de calcul.
 *
 * ⚠️ `exact: true` SUR LES CANAUX, ET CE N'EST PAS UN DÉTAIL. `getByRole(..., { name })` cherche une
 * SOUS-CHAÎNE par défaut : « RCS » désignerait aussi « WhatsApp et RCS, avec repli » et « RCS en
 * premier », donc trois nœuds, donc une violation du mode strict. Le libellé exact est ce que l'écran
 * affiche, et c'est ce qu'on vise.
 */

const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

/** Les heures d'ouverture d'un espace qui en a. */
const HEURES_OUVREES = {
  '0': { closed: true, open: '', close: '' },
  '1': { closed: false, open: '09:00', close: '18:00' },
  '2': { closed: false, open: '09:00', close: '18:00' },
  '3': { closed: false, open: '09:00', close: '18:00' },
  '4': { closed: false, open: '09:00', close: '18:00' },
  '5': { closed: false, open: '09:00', close: '18:00' },
  '6': { closed: true, open: '', close: '' },
};

async function monter(
  page: Page,
  sur: { rcsEnabled?: boolean; businessHours?: unknown; etape?: string } = {},
): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = new URL(route.request().url()).pathname.replace('/api/backend', '');
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/settings')) {
      return json({
        controlHandbackSeconds: null, mbaHandoffMode: null, mbaEnabled: false,
        rcsEnabled: sur.rcsEnabled ?? true,
        hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: true,
        timezone: 'Europe/Paris',
        businessHours: sur.businessHours === undefined ? HEURES_OUVREES : sur.businessHours,
      });
    }
    // Tout le reste de la coquille (badges de navigation, etc.) : une réponse vide suffit, l'écran
    // testé n'en dépend pas et une 404 ferait remonter une erreur sans rapport.
    return json({});
  });
  await page.goto(`/campaigns/nouvelle${sur.etape ? `?etape=${sur.etape}` : ''}`);
  await expect(page.getByTestId('assistant-campagne')).toBeVisible();
}

/** Ouvre l'assistant directement sur l'étape Canal, l'écran que la plupart de ces cas exercent. */
async function surCanal(page: Page, sur: { rcsEnabled?: boolean; businessHours?: unknown } = {}): Promise<void> {
  await monter(page, { ...sur, etape: 'canal' });
  await expect(page.getByTestId('etape-canal')).toBeVisible();
}

test('les trois entrees de canal, et la sous-question du premier canal', async ({ page }) => {
  await monter(page);
  await page.getByLabel('Nom de la campagne').fill('Essai');
  await page.getByRole('button', { name: 'Suivant' }).click();
  await page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' }).check();
  await expect(page.getByText('Lequel part en premier ?')).toBeVisible();
});

test('🔴 le nom est obligatoire : sans lui, on n avance pas', async ({ page }) => {
  // Sans cette garde, la campagne arriverait sans nom à l'étape suivante et il faudrait la redemander
  // plus tard, c'est-à-dire poser deux fois la première question de l'assistant.
  await monter(page);
  await expect(page.getByRole('button', { name: 'Suivant' })).toBeDisabled();
  await page.getByLabel('Nom de la campagne').fill('Essai');
  await expect(page.getByRole('button', { name: 'Suivant' })).toBeEnabled();
});

test('un canal non configure est grise AVEC SA RAISON, pas masque', async ({ page }) => {
  // Espace sans agent RCS.
  await surCanal(page, { rcsEnabled: false });
  const entree = page.getByRole('radio', { name: 'RCS', exact: true });
  await expect(entree).toBeDisabled();
  await expect(page.getByText(/aucun agent RCS/i)).toBeVisible();
  // 🔴 ET LE REPLI AVEC : il a besoin des DEUX canaux. Le laisser sélectionnable construirait une
  // chaîne dont le second étage ne peut rien envoyer, et l'échec n'apparaîtrait qu'à l'envoi.
  await expect(page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' })).toBeDisabled();
});

test('la question du rattrapage n apparait QUE quand il y a un reessai ou une chaine', async ({ page }) => {
  await surCanal(page);
  await page.getByRole('radio', { name: 'WhatsApp', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Réessayer les envois qui échouent' }).uncheck();
  await expect(page.getByText(/en dehors des heures d.ouverture/i)).toBeHidden();
  await page.getByRole('checkbox', { name: 'Réessayer les envois qui échouent' }).check();
  await expect(page.getByText(/en dehors des heures d.ouverture/i)).toBeVisible();
});

test('🔴 et elle apparait sur une CHAINE meme sans question de reessai', async ({ page }) => {
  // Sur une chaîne, l'écran ne pose PAS la question du réessai (le repli tient ce rôle) : c'est
  // exactement le cas où un « et » au lieu d'un « ou » ferait disparaître la question du rattrapage,
  // sur le scénario même qui l'a fait naître.
  await surCanal(page);
  await page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' }).check();
  await expect(page.getByRole('checkbox', { name: 'Réessayer les envois qui échouent' })).toHaveCount(0);
  await expect(page.getByTestId('bloc-rattrapage')).toBeVisible();
});

// ⚠️ DEUX ENTRÉES SONT GRISÉES, ET POUR DEUX RAISONS DIFFÉRENTES qu'il vaut mieux ne pas confondre : le
// SMS n'a aucune brique fournisseur, l'e-mail a toute sa chaîne SAUF un sender de campagne. Vu de
// l'utilisateur c'est le même écran, donc le même traitement ; vu du code ce sont deux chantiers distincts.
test('SMS et e-mail sont visibles et non selectionnables', async ({ page }) => {
  await surCanal(page);
  await page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' }).check();
  await expect(page.getByRole('radio', { name: /SMS/ })).toBeDisabled();
  await expect(page.getByRole('radio', { name: /E-mail/ })).toBeDisabled();
  // 🔴 DEUX, PAS UN : `getByText` seul passerait en mode strict si une seule entrée portait le badge, donc
  // ce compte est ce qui empêche d'en dégriser une sans que ce test le dise.
  await expect(page.getByText('bientôt')).toHaveCount(2);
});

test('un espace sans heures d ouverture le DIT au moment ou on coche', async ({ page }) => {
  // 🔴 La case EST la garde, et elle est cochée par défaut. On la décoche puis on la recoche pour
  // exercer le geste que décrit la spec : « au moment où l'on coche ».
  await surCanal(page, { businessHours: {} });
  const garde = page.getByRole('checkbox', { name: /heures d.ouverture/i });
  await garde.uncheck();
  await garde.check();
  await expect(page.getByText(/aucune heure d.ouverture n.est réglée/i)).toBeVisible();
});

test('un espace QUI a des heures d ouverture ne recoit aucun avertissement', async ({ page }) => {
  // L'autre sens : sans ce cas, un avertissement affiché en permanence passerait le test précédent.
  await surCanal(page);
  await expect(page.getByRole('checkbox', { name: /heures d.ouverture/i })).toBeChecked();
  await expect(page.getByText(/aucune heure d.ouverture n.est réglée/i)).toHaveCount(0);
});

test('le second canal du repli s AFFICHE et suit le premier', async ({ page }) => {
  await surCanal(page);
  await page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' }).check();
  await expect(page.getByText(/le repli part en RCS/i)).toBeVisible();
  await page.getByRole('radio', { name: 'RCS en premier' }).check();
  await expect(page.getByText(/le repli part en WhatsApp/i)).toBeVisible();
});

// 🔴 LA GARDE DE LARGEUR, sur l'etape la plus chargee : trois entrees de canal, deux
// sous-questions, une case a cocher, un encart d'avertissement et les trois cadences.
test('rien ne deborde ni ne se chevauche en 13 pouces', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  await surCanal(page, { businessHours: {} });
  await page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' }).check();
  await page.getByRole('radio', { name: 'RCS en premier' }).check();
  // ⚠️ L'E-MAIL NE SE COCHE PLUS (2026-09-12) : il est grisé tant qu'aucun sender de campagne ne sert ce
  // canal. Ce test le CONSTATE au lieu de le cliquer, ce qui lui ajoute une garde utile : le jour où
  // quelqu'un le rend cochable sans avoir écrit le sender, c'est ici que ça rougira.
  await expect(page.getByRole('radio', { name: /E-mail/ })).toBeDisabled();
  await expect(page.getByTestId('bloc-rattrapage')).toBeVisible();
  await pasDeDebordement(page);
  await pasDeChevauchement(page, ['choix-canal', 'choix-ordre', 'choix-troisieme', 'bloc-rattrapage']);
  // ⚠️ La cadence est le cinquieme bloc de l'etape : l'omettre laisserait le seul bloc non mesure etre
  // celui qui deborde.
  await pasDeChevauchement(page, ['choix-troisieme', 'bloc-rattrapage', 'choix-cadence']);
});
