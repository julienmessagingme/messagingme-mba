import { test, expect } from '@playwright/test';

/**
 * Inbox : la vignette porte DEUX gestes distincts. La zone ouvre la conversation (comme avant), le NOM ouvre
 * la fiche du contact, qui rétrécit la conversation au lieu de la recouvrir.
 *
 * Ce que ces tests protègent : que le geste historique n'ait pas été volé par le nouveau. Faire du clic sur
 * la vignette l'ouverture de la fiche aurait cassé la navigation de tous les jours pour un usage occasionnel.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const CONV = { id: 'c1', waId: '33600000001', profileName: 'Alice Martin', lastPreview: 'coucou', lastMessageAt: '2026-08-21T10:00:00Z', controlOwner: 'app_workflow' };
const CONTACT = {
  id: 'ct1', profileName: 'Alice Martin', phoneE164: '+33600000001', bsuid: null,
  optInStatus: 'opted_in', tags: ['client'], fields: { prenom: 'Alice', email: 'alice@exemple.fr' },
  createdAt: '2026-01-01T00:00:00Z',
};

/**
 * Ce que rend la route `/resume` par défaut : un contact sans aucune conversation, donc PAS de bloc résumé.
 * Les tests qui veulent un résumé le passent explicitement, pour qu'on lise dans le test ce qu'il simule.
 */
const SANS_CONVERSATION = { texte: null, analyseLe: null, conversationId: null, conversations: 0, analysee: false, perime: false };

async function mock(page: import('@playwright/test').Page, contacts: unknown[] = [CONTACT], resume: unknown = SANS_CONVERSATION) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const chemin = url.split('?')[0]!;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    // ⚠️ AVANT le cas générique `/contacts` : ce chemin se termine par `/resume`, mais l'attrape-tout final
    // rendrait `{}`, et un objet vide n'est PAS une réponse valide (cf. `etatResume`, qui refuse de lui
    // inventer un état).
    if (chemin.endsWith('/resume')) return json(resume);
    if (chemin.endsWith('/conversations/todo-count')) return json({ count: 0 });
    if (chemin.endsWith('/conversations')) return json({ conversations: [CONV] });
    if (chemin.endsWith('/c1/messages')) {
      return json({ waId: CONV.waId, windowOpen: true, lastInboundAt: CONV.lastMessageAt, controlOwner: 'app_workflow', messages: [] });
    }
    if (chemin.endsWith('/contacts')) return json({ contacts, total: contacts.length });
    if (chemin.endsWith('/user-fields')) return json({ fields: [] });
    if (chemin.endsWith('/tags')) return json({ tags: [{ tag: 'client', count: 1 }] });
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Inbox : fiche contact', () => {
  test('🔴 les champs de BASE sont visibles même VIDES, pour pouvoir les remplir', async ({ page }) => {
    // Défaut signalé par Julien le 2026-08-25 : Email n'apparaissait qu'une fois rempli, et il n'était même
    // pas proposé à l'ajout (la liste des champs ajoutables vient de `user_fields`, où un champ SOCLE n'existe
    // pas tant que personne ne l'a écrit). Un contact sans email était donc impossible à compléter depuis sa
    // fiche. Même chose pour le BSUID et l'identifiant WhatsApp, masqués quand ils sont absents.
    const nu = {
      id: 'ct2', profileName: 'Bob Vide', phoneE164: '+33600000002', bsuid: null,
      optInStatus: 'unknown', tags: [], fields: {}, createdAt: '2026-01-01T00:00:00Z',
    };
    await mock(page, [nu]);
    await page.goto('/contacts');
    await page.getByText('Bob Vide').first().click();

    const fiche = page.getByTestId('fiche-champs-base');
    // Les quatre lignes de base sont là, alors que le contact n'a AUCUN champ rempli.
    await expect(fiche.getByText('Prénom', { exact: true })).toBeVisible();
    await expect(fiche.getByText('Email', { exact: true })).toBeVisible();
    await expect(fiche.getByText('Compte WhatsApp', { exact: true })).toBeVisible();
    await expect(fiche.getByText('Identifiant WhatsApp', { exact: true })).toBeVisible();

    // L'identifiant WhatsApp est DÉRIVÉ du numéro (chiffres seuls), comme le fait la résolution serveur.
    await expect(fiche.getByText('33600000002', { exact: true })).toBeVisible();
  });

  test('un contact SANS numéro montre son BSUID comme identifiant WhatsApp', async ({ page }) => {
    const sansNumero = {
      id: 'ct3', profileName: 'Carla BSUID', phoneE164: null, bsuid: 'BSU_ab12cd34',
      optInStatus: 'unknown', tags: [], fields: {}, createdAt: '2026-01-01T00:00:00Z',
    };
    await mock(page, [sansNumero]);
    await page.goto('/contacts');
    await page.getByText('Carla BSUID').first().click();

    // Le BSUID apparaît DEUX fois : comme compte WhatsApp, et comme identifiant dérivé (il fait office des
    // deux quand le contact n'a pas partagé son numéro).
    await expect(page.getByText('BSU_ab12cd34').first()).toBeVisible();
    await expect(page.getByText('Identifiant WhatsApp', { exact: true })).toBeVisible();
  });

  test('la vignette ne montre PLUS l’extrait du message', async ({ page }) => {
    // Le fil complet est juste à côté : répéter son début en minuscule ne servait qu'à faire deviner ce
    // qu'on peut lire en entier.
    await mock(page);
    await page.goto('/inbox');
    await expect(page.getByText('Alice Martin').first()).toBeVisible();
    await expect(page.getByText('coucou')).toHaveCount(0);
  });

  test('🔴 le clic sur la VIGNETTE ouvre toujours la conversation', async ({ page }) => {
    await mock(page);
    await page.goto('/inbox');
    await page.getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).click();
    await expect(page.getByText(/fenêtre 24 h ouverte|24h window open/)).toBeVisible();
    // Et la fiche ne s'est PAS ouverte : les deux gestes sont bien distincts.
    await expect(page.getByTestId('inbox-contact-panel')).toHaveCount(0);
  });

  test('le clic sur le NOM ouvre la fiche du contact', async ({ page }) => {
    await mock(page);
    await page.goto('/inbox');
    await page.getByTestId('open-contact-c1').click();
    const panneau = page.getByTestId('inbox-contact-panel');
    await expect(panneau).toBeVisible();
    // La VRAIE fiche, celle du mini-CRM : on retrouve ses données, pas un simple encadré avec un nom.
    await expect(panneau.getByText('alice@exemple.fr')).toBeVisible();
  });

  test('un numéro sans fiche le DIT, au lieu d’afficher une fiche vide', async ({ page }) => {
    // Une conversation peut exister sans contact au mini-CRM (numéro jamais importé). Un panneau vide se
    // lirait comme une erreur de chargement.
    await mock(page, []);
    await page.goto('/inbox');
    await page.getByTestId('open-contact-c1').click();
    await expect(page.getByTestId('inbox-contact-panel')).toContainText(/Aucune fiche pour ce numéro|No contact record/);
  });
});

/**
 * LE RESUME DE LA CONVERSATION, EN CHAMP DE BASE DU MINI-CRM (demande de Julien du 2026-09-17).
 *
 * 🔴 CE QUE CES TROIS TESTS TIENNENT, ET QUE LES TESTS DU MODULE PUR NE PEUVENT PAS VOIR. `etatResume` dit
 * quel etat afficher ; il ne dit pas que le composant l'a branche, ni qu'il APPELLE la route a l'ouverture
 * de la fiche. Une garde qu'on peut debrancher sans qu'aucun test ne tombe n'est pas une garde.
 */
test.describe('Fiche contact : le resume de la conversation', () => {
  test('🔴 aucune conversation -> AUCUN bloc resume, pas un bloc vide', async ({ page }) => {
    // « un champ de base A PARTIR DU MOMENT OU il y a une conversation » (Julien). Un bloc « Resume : - »
    // sur un contact importe d'un CSV promettrait un contenu qui ne viendra jamais.
    await mock(page);
    await page.goto('/contacts');
    await page.getByText('Alice Martin').first().click();
    await expect(page.getByTestId('fiche-champs-base')).toBeVisible();
    await expect(page.getByTestId('fiche-contact-resume')).toHaveCount(0);
  });

  test('un resume -> son texte, sa date et le lien vers le fil', async ({ page }) => {
    await mock(page, [CONTACT], {
      texte: 'Alice demandait ou en etait sa livraison, on lui a donne le suivi.',
      analyseLe: '2026-08-22T09:10:00.000Z', conversationId: 'c1',
      conversations: 2, analysee: true, perime: false,
    });
    await page.goto('/contacts');
    await page.getByText('Alice Martin').first().click();
    const bloc = page.getByTestId('fiche-contact-resume');
    await expect(bloc).toBeVisible();
    await expect(page.getByTestId('fiche-contact-resume-texte')).toContainText('ou en etait sa livraison');
    // Le lien pointe la conversation d'ou vient le resume, pas l'inbox en general.
    await expect(bloc.getByRole('link')).toHaveAttribute('href', '/inbox?c=c1');
  });

  test('🔴 analysee SANS resume -> on le dit, on n affiche pas un bloc blanc', async ({ page }) => {
    // Les analyses d'avant la migration 0100 n'ont pas de resume et n'en auront jamais. Un bloc vide se
    // lirait comme une panne de chargement.
    await mock(page, [CONTACT], {
      texte: null, analyseLe: '2026-08-22T09:10:00.000Z', conversationId: 'c1',
      conversations: 1, analysee: true, perime: true,
    });
    await page.goto('/contacts');
    await page.getByText('Alice Martin').first().click();
    await expect(page.getByTestId('fiche-contact-resume-absent')).toContainText(/Pas de résumé|No summary/);
    await expect(page.getByTestId('fiche-contact-resume-texte')).toHaveCount(0);
    // Et le fil a bouge depuis l'analyse : le dire vaut mieux que de presenter un etat partiel comme entier.
    await expect(page.getByTestId('fiche-contact-resume-perime')).toBeVisible();
  });
});
