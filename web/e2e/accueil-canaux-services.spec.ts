import { test, expect, type Page } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * ACCUEIL : LE BLOC « CANAUX ET SERVICES » (plan du 2026-09-25, design validé par Julien).
 *
 * Une ligne par service : son interrupteur, son état en une phrase, le lien vers son écran. 🔴 Éteindre passe par
 * une confirmation qui dit ce qui s'arrête, rallumer ne demande rien, et chaque ligne tolère une API qui ne
 * connaît pas encore son geste. Le serveur tient ses frontières de son côté (`tests/numero-delie.test.ts`,
 * `tests/numero-activation.test.ts`, `tests/http-channels-me.test.ts`) ; ici, on regarde ce que l'écran MONTRE et
 * ce qu'il ENVOIE.
 */

const REGLAGES = { controlHandbackSeconds: null, mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false };
const CHAINE = {
  connection: { orgId: 'o1', channelId: 'c2', hasApiKey: true, hasSecret: true, verifiedAt: null },
  organisation: null,
  channels: [{ id: 'c1', name: 'Une autre' }, { id: 'c2', name: 'Ma chaîne' }],
  distant: 'ok',
};
const PUBS = {
  configure: true, configId: 'cfg', appId: 'app', graphVersion: 'v25.0',
  connexion: { comptePubId: 'act_1', compteNom: 'GMC', pageId: 'p1', pageNom: 'Page', pageLiee: 'oui', jetonRejeteLe: null },
  compte: null,
};
/** La réponse de `GET /accueil/volumes` (2026-09-25). Des milliers, pour voir le groupement ; un zéro MESURÉ en RCS. */
const VOLUMES = { jours: 30, whatsapp: { envoyes: 1234, recus: 567 }, rcs: { envoyes: 12, recus: 0 } };

/** L'interrupteur d'une ligne, sa phrase et sa pastille (la grille de cartes du 2026-09-25). */
const ligne = (page: Page, service: string) => ({
  toggle: page.getByTestId(`canal-${service}-toggle`),
  etat: page.getByTestId(`canal-${service}-etat`),
  chiffre: page.getByTestId(`canal-${service}-chiffre`),
  erreur: page.getByTestId(`canal-${service}-erreur`),
  pastille: page.getByTestId(`canal-${service}-pastille`),
});

test.describe('Accueil : Canaux et services', () => {
  test('les cinq lignes, leur état en une phrase, et le lien vers leur écran', async ({ page }) => {
    await mockAccueil(page, {
      settings: { ...REGLAGES, hubspotActif: false },
      canaux: { rcs: { active: true, channel: { agentId: 'a', brandName: 'Marque', displayName: 'Mon agent', status: 'launched', checkedAt: null } }, chaine: CHAINE, posts: [{}, {}, {}], pubs: PUBS },
      volumes: VOLUMES,
    });
    await expect(page.getByTestId('canaux-services')).toBeVisible();
    await expect(ligne(page, 'numero').etat).toHaveText('Relié : +33 5 25 68 02 50.');
    await expect(ligne(page, 'rcs').etat).toHaveText('Actif, sous l’agent « Mon agent ».');
    // Le nombre de publications a quitté la phrase (2026-09-25) : il est la ligne de chiffre de la carte.
    await expect(ligne(page, 'chaine').etat).toHaveText('Branchée : « Ma chaîne ».');
    await expect(ligne(page, 'chaine').chiffre).toHaveText('3 publications au total');
    // Envoyés et reçus sur 30 jours ; l'espace fine insécable des milliers se lit comme un espace.
    await expect(ligne(page, 'numero').chiffre).toHaveText('1 234 envoyés · 567 reçus (30 j)');
    await expect(ligne(page, 'rcs').chiffre).toHaveText('12 envoyés · 0 reçu (30 j)');
    await expect(ligne(page, 'publicites').etat).toHaveText('Connecté : GMC.');
    await expect(ligne(page, 'hubspot').etat).toContainText('Éteint');
    for (const [s, allume] of [['numero', 'true'], ['rcs', 'true'], ['chaine', 'true'], ['publicites', 'true'], ['hubspot', 'false']] as const) {
      await expect(ligne(page, s).toggle, s).toHaveAttribute('aria-pressed', allume);
    }
    await expect(page.getByTestId('canal-chaine-lien')).toHaveAttribute('href', '/chaine');
    await expect(page.getByTestId('canal-publicites-lien')).toHaveAttribute('href', '/publicites');
    await expect(page.getByTestId('canal-hubspot-lien')).toHaveAttribute('href', '/parametres#integration-hubspot');
    // « Voir le numéro » et « Voir le canal » sont partis (2026-09-25) : le détail est juste en dessous.
    await expect(page.getByTestId('canal-numero-lien')).toHaveCount(0);
    await expect(page.getByTestId('canal-rcs-lien')).toHaveCount(0);
    await expect(page.getByText('Voir le numéro', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Voir le canal', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('canal-autres-lien')).toHaveAttribute('href', '/parametres');
    await expect(page.getByTestId('canal-autres-lien')).toHaveText('Autres intégrations+');
    // 🔴 « Couper le canal RCS » est DEVENU l'interrupteur : la carte ne le porte plus.
    await expect(page.getByTestId('rcs-channel-card')).toBeVisible();
    await expect(page.getByText('Couper le canal RCS', { exact: true })).toHaveCount(0);
  });

  test('la grille : un logo par carte, une pastille qui suit l’interrupteur, et plus de phrase d’explication', async ({ page }) => {
    await mockAccueil(page, {
      settings: { ...REGLAGES, hubspotActif: false },
      canaux: { rcs: { active: true, channel: { agentId: 'a', brandName: 'Marque', displayName: 'Mon agent', status: 'launched', checkedAt: null } }, chaine: CHAINE, posts: [], pubs: PUBS },
    });
    // Ancre positive : le bloc a lu ses cinq services avant qu'on regarde ce qui n'y est plus.
    await expect(ligne(page, 'publicites').etat).toHaveText('Connecté : GMC.');
    for (const [s, logo] of [['numero', 'WhatsApp'], ['rcs', 'Google Messages'], ['chaine', 'Chaîne WhatsApp'], ['publicites', 'Meta'], ['hubspot', 'HubSpot']] as const) {
      await expect(page.getByTestId(`canal-${s}`).getByRole('img', { name: logo, exact: true }), s).toBeVisible();
    }
    for (const [s, t] of [['numero', 'vert'], ['rcs', 'vert'], ['chaine', 'vert'], ['publicites', 'vert'], ['hubspot', 'gris']] as const) {
      await expect(ligne(page, s).pastille, s).toHaveAttribute('data-teinte', t);
    }
    // Retirées à la demande de Julien (2026-09-25) : l'explication sous le titre, et la phrase sous « Bonjour ».
    await expect(page.getByText('Canaux et services', { exact: true })).toBeVisible();
    await expect(page.getByText(/Allumer ou éteindre chaque canal/)).toHaveCount(0);
    await expect(page.getByText(/Voici l.état de ton compte/)).toHaveCount(0);
    await expect(page.getByText(/^Bonjour/)).toBeVisible();
  });

  test('🔴 route des volumes pas encore déployée : ni chiffre ni zéro sur WhatsApp et RCS, le reste de la carte intact', async ({ page }) => {
    const lectures: string[] = [];
    await mockAccueil(page, {
      canaux: { rcs: { active: true, channel: { agentId: 'a', brandName: 'Marque', displayName: 'Mon agent', status: 'launched', checkedAt: null } } },
      volumes: 'absent',
      lecturesChiffres: lectures,
    });
    // Ancres positives : les cartes ont lu leur état, ET la lecture des volumes a bien eu lieu (et a rendu 404).
    await expect(ligne(page, 'numero').etat).toHaveText('Relié : +33 5 25 68 02 50.');
    await expect(ligne(page, 'rcs').etat).toHaveText('Actif, sous l’agent « Mon agent ».');
    await expect.poll(() => lectures).toContain('GET /tenants/t-e2e/accueil/volumes');
    await expect(ligne(page, 'numero').chiffre).toHaveCount(0);
    await expect(ligne(page, 'rcs').chiffre).toHaveCount(0);
    await expect(page.getByTestId('canaux-services').getByText(/envoy|reçu/)).toHaveCount(0);
    await expect(ligne(page, 'numero').toggle).toHaveAttribute('aria-pressed', 'true');
  });

  test('compte publicitaire connecté mais pas choisi : pastille AMBRE, « à terminer »', async ({ page }) => {
    await mockAccueil(page, { canaux: { pubs: { ...PUBS, connexion: { ...PUBS.connexion, comptePubId: null, compteNom: null } } } });
    const pubs = ligne(page, 'publicites');
    await expect(pubs.etat).toContainText('Connexion à terminer');
    await expect(pubs.pastille).toHaveAttribute('data-teinte', 'ambre');
    await expect(pubs.toggle).toHaveAttribute('aria-pressed', 'true');
  });

  test('🔴 délier le numéro : la confirmation dit ce qui s’arrête, « Annuler » n’envoie rien, confirmer délie', async ({ page }) => {
    const gestes: string[] = [];
    await mockAccueil(page, { canaux: { gestes } });
    const numero = ligne(page, 'numero');
    await expect(numero.toggle).toHaveAttribute('aria-pressed', 'true');

    await numero.toggle.click();
    const dialogue = page.getByTestId('canaux-confirmation');
    await expect(dialogue).toBeVisible();
    await expect(dialogue).toContainText('Plus aucun message WhatsApp ne part de cet espace');
    await expect(dialogue).toContainText('Le RCS et les e-mails continuent');
    await expect(dialogue).toContainText('ne seront pas repris au retour');
    await expect(dialogue).toContainText('campagnes en cours ou programmées passent en pause');
    await expect(dialogue).toContainText('ne sont plus enregistrés');
    await expect(dialogue).toContainText('Rien ne change chez Meta');
    await page.getByTestId('canaux-confirmation-annuler').click();
    await expect(dialogue).toHaveCount(0);
    expect(gestes).toEqual([]);

    await numero.toggle.click();
    await page.getByTestId('canaux-confirmation-ok').click();
    await expect(numero.etat).toContainText('délié le');
    await expect(numero.toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(numero.pastille).toHaveAttribute('data-teinte', 'gris');
    await expect(page.getByTestId('canaux-info')).toContainText('2 campagne(s) mise(s) en pause');
    expect(gestes).toEqual(['POST /tenants/t-e2e/numero/delier']);
  });

  test('🔴 relier : SANS confirmation, d’un clic', async ({ page }) => {
    const gestes: string[] = [];
    await mockAccueil(page, { account: { delieLe: '2026-09-24T08:00:00.000Z' }, canaux: { gestes } });
    const numero = ligne(page, 'numero');
    await expect(numero.etat).toContainText('délié le');
    await expect(numero.toggle).toHaveAttribute('aria-pressed', 'false');
    await numero.toggle.click();
    await expect(page.getByTestId('canaux-confirmation')).toHaveCount(0);
    await expect(numero.etat).toHaveText('Relié : +33 5 25 68 02 50.');
    await expect(numero.toggle).toHaveAttribute('aria-pressed', 'true');
    expect(gestes).toEqual(['POST /tenants/t-e2e/numero/relier']);
  });

  test('🔴 API plus ancienne : le geste neuf n’existe pas, l’écran le DIT et l’interrupteur reste à sa place', async ({ page }) => {
    const gestes: string[] = [];
    // Ni `delieLe` dans le statut (API d'avant 0180), ni la route : le numéro est lu relié, ce qu'il était.
    await mockAccueil(page, { canaux: { routesAbsentes: true, gestes, chaine: CHAINE } });
    const numero = ligne(page, 'numero');
    await expect(numero.toggle).toHaveAttribute('aria-pressed', 'true');
    await numero.toggle.click();
    await page.getByTestId('canaux-confirmation-ok').click();
    await expect(numero.erreur).toContainText('pas encore disponible');
    await expect(numero.toggle).toHaveAttribute('aria-pressed', 'true');

    const chaine = ligne(page, 'chaine');
    await chaine.toggle.click();
    await page.getByTestId('canaux-confirmation-ok').click();
    await expect(chaine.erreur).toContainText('pas encore disponible');
    await expect(chaine.toggle).toHaveAttribute('aria-pressed', 'true');
    expect(gestes).toEqual(['POST /tenants/t-e2e/numero/delier', 'DELETE /tenants/t-e2e/channels-me/connection']);
  });

  test('canal RCS : couper se confirme ; rallumer ouvre la clé du canal, sans confirmation', async ({ page }) => {
    const gestes: string[] = [];
    await mockAccueil(page, { canaux: { gestes, rcs: { active: true, channel: { agentId: 'a', brandName: 'Marque', displayName: null, status: 'launched', checkedAt: null } } } });
    const rcs = ligne(page, 'rcs');
    await rcs.toggle.click();
    await expect(page.getByTestId('canaux-confirmation')).toContainText('La clé du canal est oubliée');
    await page.getByTestId('canaux-confirmation-ok').click();
    await expect(rcs.toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('rcs-channel-card')).toContainText('inactif');
    expect(gestes).toEqual(['DELETE /tenants/t-e2e/rcs/channel']);

    await rcs.toggle.click();
    await expect(page.getByTestId('canaux-confirmation')).toHaveCount(0);
    await expect(page.getByTestId('rcs-channel-key')).toBeVisible();
  });

  test('chaîne : débrancher se confirme, les publications restent ; débranchée, l’allumer ouvre l’écran Chaîne', async ({ page }) => {
    const gestes: string[] = [];
    await mockAccueil(page, { canaux: { gestes, chaine: CHAINE, posts: [{}] } });
    const chaine = ligne(page, 'chaine');
    await expect(chaine.etat).toHaveText('Branchée : « Ma chaîne ».');
    await expect(chaine.chiffre).toHaveText('1 publication au total');
    await chaine.toggle.click();
    await expect(page.getByTestId('canaux-confirmation')).toContainText('Les publications déjà parues restent');
    await page.getByTestId('canaux-confirmation-ok').click();
    await expect(chaine.etat).toContainText('Non branchée');
    // Débranchée, le compte ne se relit plus : la carte ne garde pas un chiffre qu'elle n'a plus lu.
    await expect(chaine.chiffre).toHaveCount(0);
    expect(gestes).toEqual(['DELETE /tenants/t-e2e/channels-me/connection']);

    await chaine.toggle.click();
    await expect(page.getByTestId('canaux-confirmation')).toHaveCount(0);
    await page.waitForURL('**/chaine');
  });

  test('compte publicitaire : la déconnexion actuelle, confirmée ; route absente, pas d’interrupteur', async ({ page }) => {
    const gestes: string[] = [];
    await mockAccueil(page, { canaux: { gestes, pubs: PUBS } });
    const pubs = ligne(page, 'publicites');
    await pubs.toggle.click();
    await expect(page.getByTestId('canaux-confirmation')).toContainText('ne sont pas arrêtées par ce geste');
    await page.getByTestId('canaux-confirmation-ok').click();
    await expect(pubs.etat).toContainText('Non connecté');
    await expect(pubs.toggle).toHaveAttribute('aria-pressed', 'false');
    expect(gestes).toEqual(['DELETE /tenants/t-e2e/pubs/connexion']);
  });

  test('compte publicitaire : route pas encore déployée, la ligne le dit, sans interrupteur', async ({ page }) => {
    await mockAccueil(page, { canaux: { pubs: 'absent', chaine: CHAINE } });
    // Ancre positive d'abord : le bloc a lu ses services (la chaîne est affichée).
    await expect(ligne(page, 'chaine').etat).toContainText('Branchée');
    await expect(ligne(page, 'publicites').etat).toHaveText('Indisponible sur cette instance pour le moment.');
    await expect(ligne(page, 'publicites').toggle).toHaveCount(0);
    // 🔴 Pas de pastille non plus : un gris dirait « éteint », ce qu'on n'a pas lu.
    await expect(ligne(page, 'publicites').pastille).toHaveCount(0);
  });

  test('🔴 HubSpot : l’allumer ne demande rien et fait apparaître le bloc ; relié à un portail, l’extinction est grisée', async ({ page }) => {
    const gestes: string[] = [];
    await mockAccueil(page, { settings: { ...REGLAGES, hubspotActif: false }, canaux: { gestes } });
    const hubspot = ligne(page, 'hubspot');
    await expect(page.getByTestId('hubspot-renvoi')).toBeVisible();
    await hubspot.toggle.click();
    await expect(page.getByTestId('canaux-confirmation')).toHaveCount(0);
    await expect(hubspot.toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('hubspot-card')).toBeVisible();
    expect(gestes).toEqual(['PATCH /tenants/t-e2e/settings/hubspot-actif']);
  });

  test('HubSpot allumé et relié : interrupteur grisé, et la raison est dite', async ({ page }) => {
    await mockAccueil(page, {
      account: { hubspotPortal: { connected: true, hubId: '1', hubDomain: 'cobaye.hubspot.com', listsScopeGranted: true } },
      settings: { ...REGLAGES, hubspotActif: true },
      canaux: {},
    });
    await expect(ligne(page, 'hubspot').toggle).toBeDisabled();
    await expect(ligne(page, 'hubspot').etat).toContainText('un portail est relié');
  });
});
