import { test, expect, type Page } from '@playwright/test';
import { TREIZE_POUCES, pasDeDebordement, pasDeChevauchement } from './aide/largeur';

/**
 * E2E de l'assistant de campagne, étapes Audience et Récapitulatif.
 *
 * 🔴 LE RÉCAP N'EST PAS UN RÉSUMÉ, ET C'EST CE QUE CES TESTS PROTÈGENT. L'audience arrive APRÈS le
 * contenu : l'opérateur a réglé ses étages sans savoir combien de monde chacun couvre. Un écran qui
 * relirait ses choix ne lui apprendrait rien. Les trois premiers cas vérifient donc des NOMBRES, pas
 * des libellés.
 *
 * 🔴 ET SON RISQUE DE LARGEUR N'EST PAS LE CHEVAUCHEMENT, C'EST LA COUPE. Il porte le seul tableau de
 * l'assistant, donc le seul endroit où la LARGEUR EST COMMANDÉE PAR UNE DONNÉE. Un tableau large doit
 * scroller DANS SON PROPRE conteneur ; la page, elle, ne scrolle jamais de côté. Le pire cas réaliste
 * d'une cellule est un nombre à sept chiffres, et c'est exactement ce que le dernier cas envoie.
 *
 * ⚠️ LES SÉPARATEURS DE MILLIERS SONT DES ESPACES INSÉCABLES ÉTROITES (U+202F) dans l'ICU récent :
 * `fmtNum(1000, 'fr')` ne rend PAS « 1 000 » avec une espace ordinaire. Les assertions passent donc par
 * des expressions régulières à `\\s`, qui couvre U+202F, plutôt que par des chaînes littérales qui
 * passeraient ou non selon l'ICU de la machine qui exécute le test.
 */

const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const TEMPLATES = [{ id: 't1', name: 'promo_rentree', status: 'APPROVED', category: 'MARKETING', language: 'fr' }];
const EMAIL_TEMPLATES = [{ id: 'em1', name: 'Relance e-mail', format: 'html', subject: 's', body: 'b', createdAt: '', updatedAt: '' }];
const CHAMPS = [
  { key: 'ville', label: 'Ville', type: 'text' },
  { key: 'email', label: 'Adresse e-mail', type: 'text' },
];

/**
 * Les trois comptes du récapitulatif, servis par le MÊME endpoint avec des filtres différents.
 *
 * 🔴 C'EST LE FILTRE QUI DÉCIDE, PAS L'ORDRE D'APPEL. Répondre « le premier appel vaut le total, le
 * deuxième les joignables » ferait passer n'importe quelle implémentation, y compris une qui lancerait
 * ses trois requêtes dans le désordre, ce qui est le cas normal de trois effets React concurrents. On
 * lit donc la REQUÊTE, avec les MÊMES noms de paramètres que le serveur (`filtersToQuery`).
 */
function compteur(sur: { retenus: number; joignables: number; sansAdresse: number }) {
  return (q: URLSearchParams): { total: number } => {
    if (q.get('fields')) return { total: sur.sansAdresse };
    if (q.get('joignabilite') === 'connu_injoignable') return { total: sur.joignables };
    return { total: sur.retenus };
  };
}

async function monter(
  page: Page,
  sur: { retenus?: number; joignables?: number; sansAdresse?: number; etape?: string } = {},
): Promise<void> {
  const compte = compteur({
    retenus: sur.retenus ?? 1000,
    joignables: sur.joignables ?? 940,
    sansAdresse: sur.sansAdresse ?? 12,
  });
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = new URL(route.request().url()).pathname.replace('/api/backend', '');
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/settings')) {
      return json({
        controlHandbackSeconds: null, mbaHandoffMode: null, mbaEnabled: true, rcsEnabled: true,
        hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: true,
        timezone: 'Europe/Paris', businessHours: {},
      });
    }
    if (chemin.endsWith('/contacts/count')) {
      return json(compte(new URL(route.request().url()).searchParams));
    }
    if (chemin.endsWith('/email-templates')) return json({ templates: EMAIL_TEMPLATES });
    if (chemin.endsWith('/templates')) return json({ templates: TEMPLATES });
    if (chemin.endsWith('/workflows')) return json({ workflows: [] });
    if (chemin.endsWith('/users')) return json({ users: [] });
    if (chemin.endsWith('/agents')) return json({ agents: [] });
    if (chemin.endsWith('/tags')) return json({ tags: [{ tag: 'vip', count: 12 }] });
    if (chemin.endsWith('/user-fields')) return json({ fields: CHAMPS });
    if (chemin.endsWith('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33 5 25 68 02 50', verifiedName: 'Engage Me' }] });
    if (chemin.endsWith('/rcs-agents')) return json({ agents: [{ agentId: 'ag1', brandName: 'Marque', status: 'LAUNCHED' }] });
    return json({});
  });
  const q = new URLSearchParams({ etape: sur.etape ?? 'recap', canal: 'repli', troisieme: 'email' });
  await page.goto(`/campaigns/nouvelle?${q.toString()}`);
}

test('le recap montre la repartition par etage, pas un resume', async ({ page }) => {
  await monter(page);
  await expect(page.getByTestId('etape-recap')).toBeVisible();
  await expect(page.getByTestId('lien-audience')).toHaveText(/1\s?000 contacts retenus/);
  await expect(page.getByTestId('repartition-1')).toHaveText(/940 partiront en WhatsApp/);
  await expect(page.getByTestId('repartition-2')).toHaveText(/60 basculeront en RCS/);
  await expect(page.getByTestId('repartition-3')).toHaveText(/12 n.ont pas d.adresse e-mail/);
});

/**
 * 🔴 L'AUTRE SENS, ET IL SÉPARE LA VRAIE IMPLÉMENTATION DE LA FAUSSE. Un écran qui afficherait des
 * nombres FIGÉS passerait le cas du dessus. Ici les trois comptes changent, et les trois lignes doivent
 * suivre : 500 retenus dont 500 joignables, c'est « personne ne bascule », pas « 60 basculeront ».
 */
test('les nombres viennent des comptes, ils ne sont pas figes', async ({ page }) => {
  await monter(page, { retenus: 500, joignables: 500, sansAdresse: 0 });
  await expect(page.getByTestId('repartition-1')).toHaveText(/500 partiront en WhatsApp/);
  await expect(page.getByTestId('repartition-2')).toHaveText(/0 basculeront en RCS/);
  await expect(page.getByTestId('repartition-3')).toHaveText(/Toutes les fiches/);
});

test('chaque ligne ramene a son etape', async ({ page }) => {
  await monter(page);
  await page.getByRole('link', { name: /contacts retenus/ }).click();
  await expect(page.getByRole('heading', { name: 'Audience' })).toBeVisible();
});

/**
 * 🔴 LE RÉCAP PORTE UN TABLEAU DE RÉPARTITION, donc le risque n'est pas le chevauchement mais la COUPE.
 * Un tableau large scrolle DANS SON PROPRE conteneur, la page ne scrolle jamais de côté.
 */
test('la repartition ne fait pas deborder la page en 13 pouces', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  await monter(page);
  await expect(page.getByTestId('repartition')).toBeVisible();
  await pasDeDebordement(page);
  await pasDeChevauchement(page, ['repartition', 'bloc-cout', 'bouton-lancer']);
});

/**
 * 🔴 LEÇON DU LOT 4, ET ELLE VAUT ICI AUSSI : trois blocs côte à côte passent `pasDeDebordement` ET
 * `pasDeChevauchement` sans rien déclencher. Seule une assertion d'EMPILEMENT les attrape. Un contrôle
 * de dégât ne remplace pas un contrôle de disposition.
 */
test('le tableau, le bloc de cout et le bouton sont EMPILES, jamais cote a cote', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  await monter(page);
  const table = (await page.getByTestId('repartition').boundingBox())!;
  const cout = (await page.getByTestId('bloc-cout').boundingBox())!;
  const bouton = (await page.getByTestId('bouton-lancer').boundingBox())!;
  expect(cout.y).toBeGreaterThanOrEqual(table.y + table.height);
  expect(bouton.y).toBeGreaterThanOrEqual(cout.y + cout.height);
});

/**
 * ⚠️ UN NOMBRE À SEPT CHIFFRES (1 000 000 de contacts) EST LE PIRE CAS DE LARGEUR D'UNE CELLULE, et il
 * n'a rien de théorique : le plafond de destinataires du produit est à 20 000, mais le COMPTE affiché
 * est celui de l'espace entier avant plafonnement, et le dépôt a déjà vu des CRM à six chiffres.
 */
test('des grands nombres ne cassent pas la mise en page', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  await monter(page, { retenus: 1_000_000, joignables: 940_000, sansAdresse: 1_234_567 });
  await expect(page.getByTestId('repartition-1')).toBeVisible();
  await pasDeDebordement(page);
  await pasDeChevauchement(page, ['repartition', 'bloc-cout', 'bouton-lancer']);
});

/**
 * 🔴 CE QUE LE RÉCAP NE DIT PAS, ET QUI DOIT LE RESTER. Le plafond marketing 131049 de Meta est par
 * UTILISATEUR et vit chez Meta : aucun compte de notre base ne l'approche. Un écran qui l'annoncerait
 * serait cru, et il serait faux.
 */
test('le recap n annonce rien sur le plafond de Meta', async ({ page }) => {
  await monter(page);
  await expect(page.getByTestId('etape-recap')).not.toContainText('131049');
  await expect(page.getByTestId('etape-recap')).not.toContainText(/plafond de Meta/i);
});

test('l etape Audience compte les contacts retenus', async ({ page }) => {
  await monter(page, { etape: 'audience' });
  await expect(page.getByTestId('audience-compte')).toHaveText(/1\s?000 contacts retenus/);
});

// ⚠️ La case d'exclusion CHANGE le compte, donc le sens de tout le récapitulatif : cocher sans que le
// nombre bouge voudrait dire que le filtre n'est pas posé, ce qui est invisible autrement.
test('ecarter les injoignables change le nombre retenu', async ({ page }) => {
  await monter(page, { etape: 'audience' });
  await expect(page.getByTestId('audience-compte')).toHaveText(/1\s?000 contacts retenus/);
  await page.getByTestId('audience-sans-injoignables').check();
  await expect(page.getByTestId('audience-compte')).toHaveText(/940 contacts retenus/);
});

test('l audience tient dans un 13 pouces, tags compris', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  await monter(page, { etape: 'audience' });
  await page.getByRole('radio', { name: 'Ceux qui portent un de ces tags' }).check();
  await expect(page.getByTestId('choix-tags')).toBeVisible();
  await pasDeDebordement(page);
  await pasDeChevauchement(page, ['choix-audience', 'audience-compte']);
});
