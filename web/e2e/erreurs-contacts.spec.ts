import { test, expect } from '@playwright/test';

/**
 * Un clic sur une ligne d'erreur ouvre LA LISTE DES CONTACTS TOUCHÉS (Console > Sécurité > Journal des
 * erreurs, où la carte a déménagé le 2026-09-17 ; elle vivait dans Analytics > Quantitatif > Erreurs).
 *
 * 🔴 CE QUE CET ÉCRAN PEUT ET NE PEUT PAS DIRE, mesuré avant d'être promis. Deux trous, tous deux réels :
 * `error_code` n'existe que sur `campaign_recipients` (un envoi de scénario ou d'inbox ne journalise que son
 * succès), et ce tableau est classé PAR CODE, donc un échec sans code Meta n'y a pas de ligne (2 sur 25 en
 * production). La carte doit dire les deux, sinon un écran vide se lit « aucune erreur » au lieu de « on ne
 * sait pas ». La liste elle-même est servie par le JOURNAL des erreurs de livraison, celui de Paramètres :
 * une seconde requête a été écrite puis supprimée, elle comptait une population voisine et les deux écrans
 * se seraient contredits.
 *
 * ⚠️ La liste suit les FILTRES de la carte. Sans ça, un clic sous un chiffre filtré par campagne ouvrirait
 * les contacts de toutes les campagnes : la liste répondrait à une autre question que le chiffre au-dessus.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const ERREURS = [
  { code: 131026, count: 4, templateName: 'tpl-un', campaignId: 'camp-a', campaignName: 'Promo A' },
  { code: 131047, count: 2, templateName: 'tpl-deux', campaignId: 'camp-b', campaignName: 'Promo B' },
];

/**
 * La forme rendue est celle du JOURNAL DES ERREURS DE LIVRAISON, celui de Parametres : le serveur ne
 * construit pas une seconde forme pour Analytics. Une fixture qui inventerait la sienne ne prouverait rien.
 */
const CONTACTS = [
  { recipientId: 'r1', campaignId: 'camp-a', campaignName: 'Promo A', telephone: '+33600000001', contactId: 'ct1', contactNom: 'Lea Martin', code: 131026, message: 'Re-engagement message', origine: 'envoi', at: '2026-09-05T10:00:00.000Z' },
  { recipientId: 'r2', campaignId: 'camp-a', campaignName: 'Promo A', telephone: '+33600000002', contactId: 'ct2', contactNom: null, code: 131026, message: null, origine: 'livraison', at: null },
];

/** Monte l'onglet Erreurs et rend les URL des appels « contacts touchés », dans l'ordre où ils partent. */
async function monter(page: import('@playwright/test').Page, opts: { tronque?: boolean } = {}) {
  const appelsContacts: string[] = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    // L'ordre compte : le chemin des contacts contient aussi « /stats/errors ».
    if (url.includes('/stats/errors/') && url.includes('/contacts')) {
      appelsContacts.push(url);
      return json({ contacts: CONTACTS, tronque: opts.tronque === true, plafond: 200 });
    }
    if (url.includes('/stats/errors')) return json({ errors: ERREURS });
    if (url.includes('/campaigns')) return json({ campaigns: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
  // ⚠️ L ECRAN A DEMENAGE LE 2026-09-17 : la carte des erreurs a quitte Analytics > Quantitatif pour le
  // centre de Securite, ou elle rejoint les deux journaux. Le CAS exerce ici n a pas bouge d un mot, seule
  // l adresse change ; ce test couvre desormais aussi le fait que la carte rend bien a son nouvel endroit.
  await page.goto('/securite/erreurs');
  await expect(page.getByTestId('erreur-ligne-131026')).toBeVisible({ timeout: 15_000 });
  return { appelsContacts };
}

test.describe('Erreurs : les contacts touchés', () => {
  test('🔴 U8 : un clic sur une ligne ouvre la liste des contacts touchés', async ({ page }) => {
    await monter(page);
    // Rien n'est ouvert au départ : la liste coûte une requête par code, les ouvrir toutes en ferait autant.
    await expect(page.getByTestId('erreur-contacts-131026')).toHaveCount(0);

    await page.getByTestId('erreur-ligne-131026').click();
    const liste = page.getByTestId('erreur-contacts-131026');
    await expect(liste).toBeVisible();
    await expect(liste).toContainText('Lea Martin');
    // Sans nom d'affichage, c'est le NUMÉRO qui s'affiche : une ligne vide ne dirait pas qui a été touché.
    await expect(liste).toContainText('33600000002');
    // Et CE QUE META A REPONDU : sans lui, on sait qui a echoue mais pas ce qu'on peut y faire.
    await expect(liste).toContainText('Re-engagement message');
  });

  test('🔴 U8 : la requête porte LE code de la ligne cliquée', async ({ page }) => {
    // Sans ceci, une carte qui demanderait toujours le même code passerait : le test prouverait qu'une liste
    // s'ouvre, pas qu'elle montre les contacts DE CETTE ligne.
    const { appelsContacts } = await monter(page);
    await page.getByTestId('erreur-ligne-131047').click();
    await expect(page.getByTestId('erreur-contacts-131047')).toBeVisible();
    await expect.poll(() => appelsContacts.some((u) => u.includes('/stats/errors/131047/contacts'))).toBe(true);
    expect(appelsContacts.some((u) => u.includes('/stats/errors/131026/contacts')), 'le code d’une AUTRE ligne est parti').toBe(false);
  });

  test('🔴 U8 : la liste suit le filtre de campagne de la carte', async ({ page }) => {
    const { appelsContacts } = await monter(page);
    await page.getByTestId('erreurs-campagnes').selectOption('camp-a');
    await page.getByTestId('erreur-ligne-131026').click();
    await expect.poll(() => appelsContacts.some((u) => new URL(u).searchParams.get('campaignIds') === 'camp-a')).toBe(true);
  });

  test('🔴 changer de filtre REFERME la liste ouverte', async ({ page }) => {
    // Une liste laissée ouverte ne correspondrait plus au chiffre affiché au-dessus, et rien ne le dirait.
    await monter(page);
    await page.getByTestId('erreur-ligne-131026').click();
    await expect(page.getByTestId('erreur-contacts-131026')).toBeVisible();

    await page.getByTestId('erreurs-campagnes').selectOption('camp-a');
    await expect(page.getByTestId('erreur-contacts-131026')).toHaveCount(0);
  });

  test('🔴 une liste TRONQUÉE le dit', async ({ page }) => {
    // Une liste coupée en silence se lit comme une liste complète, donc comme un décompte plus petit que le
    // chiffre juste au-dessus d'elle.
    await monter(page, { tronque: true });
    await page.getByTestId('erreur-ligne-131026').click();
    await expect(page.getByTestId('erreur-contacts-tronque-131026')).toContainText('200');
  });

  test('🔴 la carte DIT LES DEUX choses que ce décompte ne montre pas', async ({ page }) => {
    // Mesuré le 2026-09-07 : (1) aucun envoi hors campagne ne peut porter une erreur, (2) un échec SANS code
    // Meta n'a pas de ligne dans un tableau classé PAR CODE, et il y en a 2 sur 25 en production. Taire l'un
    // ou l'autre ferait lire cet écran comme un inventaire complet.
    await monter(page);
    const carte = page.locator('#quanti-erreurs');
    await expect(carte).toContainText(/envois de campagne|campaign sends/);
    await expect(carte).toContainText(/sans code Meta|without a Meta code/);
    // Et il DIT où est le journal complet : signaler un trou sans dire où regarder n'aide personne.
    await expect(carte).toContainText(/Erreurs de livraison|Delivery errors/);
  });
});
