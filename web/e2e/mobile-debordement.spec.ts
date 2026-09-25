import { test, expect, type Page, type Route } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * 🔴 AUCUN ÉCRAN PRINCIPAL NE DÉBORDE SUR UN TÉLÉPHONE (passe 2 de la refonte, 2026-09-25).
 *
 * Mesuré avant la passe sur un écran de 390 px : l'Inbox avec un fil ouvert faisait 601 px de large (la barre
 * d'envoi ne passait pas à la ligne, et la grille prenait la largeur de son contenu), Sécurité > Consentement
 * 512 px (un tableau à quatre colonnes). Une page qui déborde se fait défiler de côté au pouce, et la moitié
 * d'un bouton sort de l'écran sans que rien ne le signale sur un grand écran.
 *
 * Et le bouton d'aide ne recouvre plus « Envoyer » : il flottait en bas à droite, exactement sur lui, sur
 * ordinateur comme sur téléphone.
 *
 * ⚠️ Les fixtures reprennent celles des specs existantes (contacts-bilan, campagnes-cout-reel, inbox-dossiers,
 * workflow-publication, parametres, performance-synthese, securite-navigation).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const BUSINESS_HOURS = {
  '0': { closed: true, open: '', close: '' }, '1': { closed: false, open: '09:00', close: '18:00' },
  '2': { closed: false, open: '09:00', close: '18:00' }, '3': { closed: false, open: '09:00', close: '18:00' },
  '4': { closed: false, open: '09:00', close: '18:00' }, '5': { closed: false, open: '09:00', close: '18:00' },
  '6': { closed: true, open: '', close: '' },
};
const SETTINGS = { controlHandbackSeconds: null, mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: BUSINESS_HOURS };
const AUJ = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });

const CONTACTS = [
  { id: 'ct1', phoneE164: '+33600000001', waId: '33600000001', profileName: 'Anna Martin', optInStatus: 'in', tags: ['vip'], fields: {}, createdAt: '2026-09-01T10:00:00Z' },
  { id: 'ct2', phoneE164: '+33600000002', waId: '33600000002', profileName: 'Bruno Leclerc', optInStatus: 'in', tags: [], fields: {}, createdAt: '2026-09-02T10:00:00Z' },
  { id: 'ct3', phoneE164: '+33600000003', waId: '33600000003', profileName: 'Chloé Durand', optInStatus: 'out', tags: [], fields: {}, createdAt: '2026-09-03T10:00:00Z' },
  { id: 'ct4', phoneE164: '+33600000004', waId: '33600000004', profileName: 'David Roux', optInStatus: 'in', tags: [], fields: {}, createdAt: '2026-09-04T10:00:00Z' },
];
const counts = { total: 120, pending: 0, sending: 0, sent: 112, failed: 8, skipped: 0 };
const campagne = (id: string, name: string, templateName: string | null, status = 'completed') => ({
  id, name, category: 'marketing', status, phoneNumberId: 'pn1',
  templateName, templateLanguage: templateName ? 'fr' : null, workflowName: templateName ? null : 'Parcours',
  createdAt: '2026-09-14T09:00:00.000Z', scheduledAt: null, archivedAt: null, counts,
});
const CAMPAIGNS = [campagne('c-tpl', 'Rentrée VIP', 'bordeo'), campagne('c-wf', 'Relance panier', null), campagne('c-draft', 'Soldes hiver', 'bordeo', 'draft')];
const COUT = {
  lignes: [
    { campaignId: 'c-tpl', nom: 'Rentrée VIP', template: 'bordeo', envoyes: 112, envois: 120, cout: 7.97, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, clics: 14, coutParClic: 0.57 },
    { campaignId: 'c-wf', nom: 'Relance panier', template: null, envoyes: 112, envois: 120, cout: null, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, clics: null, coutParClic: null },
    { campaignId: 'c-draft', nom: 'Soldes hiver', template: 'bordeo', envoyes: 0, envois: 0, cout: 0, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, clics: null, coutParClic: null },
  ],
  tronque: false, currency: 'EUR', hasRates: true,
};
const CONVERSATIONS = [
  { id: 'c1', waId: '33600000001', profileName: 'Alice Moreau', lastPreview: 'Bonjour, ma commande est-elle partie ?', lastMessageAt: '2026-09-25T10:00:00Z', controlOwner: 'app_human', unread: true, curseur: '2026-09-25T10:00:00Z', lastDirection: 'in' },
  { id: 'c2', waId: '33600000002', profileName: 'Bob Laurent', lastPreview: 'Merci beaucoup', lastMessageAt: '2026-09-25T09:00:00Z', controlOwner: 'app_workflow', unread: false, curseur: '2026-09-25T09:00:00Z', traitee: true },
  { id: 'c3', waId: '33600000003', profileName: 'Camille Petit', lastPreview: 'Je voudrais changer d’adresse', lastMessageAt: '2026-09-24T17:30:00Z', controlOwner: 'mba', unread: false, curseur: '2026-09-24T17:30:00Z' },
];
const COMPTEURS = { tout: 3, aTraiter: 1, signalees: 0, archivees: 3, traitees: 4, nonAffectees: 1, parMembre: [{ userId: 'u-jean', nom: 'Jean', n: 1 }, { userId: 'u-marie', nom: 'Marie', n: 0 }] };
const THREAD = {
  waId: '33600000001', windowOpen: true, lastInboundAt: '2026-09-25T10:00:00Z', controlOwner: 'app_human',
  messages: [
    { id: 'm1', direction: 'out', type: 'text', body: 'Votre commande 4812 est confirmée.', buttonPayload: null, createdAt: '2026-09-24T08:00:00Z', status: 'read' },
    { id: 'm2', direction: 'in', type: 'text', body: 'Bonjour, ma commande est-elle partie ?', buttonPayload: null, createdAt: '2026-09-25T10:00:00Z' },
  ],
};
const WF_GRAPH = {
  nodes: [
    { id: 't', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } },
    { id: 'q', type: 'question', position: { x: 360, y: 0 }, data: { wfType: 'question', body: 'Ça vous convient ?', buttonLabel: 'Répondre', rows: [{ title: 'Oui' }, { title: 'Non' }] } },
    { id: 'c', type: 'condition', position: { x: 720, y: 0 }, data: { match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'q' }],
};
const WF = { id: 'wf1', name: 'Relance panier', graph: WF_GRAPH, draftGraph: null, publishedAt: '2026-08-01T09:00:00.000Z', createdAt: '2026-08-01T09:00:00.000Z', updatedAt: '2026-08-01T09:00:00.000Z' };
const NUAGE = { points: [{ satisfaction: 0, urgence: 10, n: 1 }, { satisfaction: 9, urgence: 1, n: 3 }, { satisfaction: 6, urgence: 4, n: 2 }], moyenne: { satisfaction: 6.75, urgence: 3.25 }, mesurees: 6, sansMesure: 12 };

async function monter(page: Page): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route: Route) => {
    const req = route.request();
    const url = req.url();
    const chemin = new URL(url).pathname.replace('/api/backend', '');
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/contacts/desabonnes')) return json({ contacts: [
      { id: 'ct1', profileName: 'Alice Moreau', phoneE164: '+33600000001', desabonneLe: '2026-09-12T10:00:00.000Z', source: 'scenario' },
      { id: 'ct2', profileName: null, phoneE164: '+33600000002', desabonneLe: null, source: 'webhook:formulaire-site-principal' },
    ] });
    if (chemin.endsWith('/contacts/refus-possibles')) return json({ scannes: 42, refus: [
      { messageId: 'm1', conversationId: 'cv1', contactId: 'ct9', waId: '33600000009', profileName: 'Bob', body: 'arrêtez de me contacter, je ne veux plus recevoir vos messages', recuLe: '2026-09-12T09:00:00.000Z' },
    ] });
    if (chemin.endsWith('/settings/poussee-optout')) return json({ requestId: null, requetes: [{ id: 'rq-1', label: 'Desabonner dans le CRM' }] });
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (chemin.endsWith('/settings')) return json(SETTINGS);
    if (url.includes('/unread-count')) return json({ count: 3 });
    if (/\/conversations\/counts/.test(url)) return json(COMPTEURS);
    if (chemin.endsWith('/c1/messages')) return json(THREAD);
    if (/\/conversations$/.test(chemin)) return json({ conversations: CONVERSATIONS });
    if (url.includes('/contacts/count')) return json({ count: 4 });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/tags')) return json({ tags: ['vip'] });
    if (/\/contacts$/.test(chemin)) return json({ contacts: CONTACTS, total: 4 });
    if (url.includes('/stats/cost/campaigns')) return json(COUT);
    if (url.includes('/stats/conversations/nuage')) return json(NUAGE);
    if (url.includes('/stats/templates')) return json({ breakdown: [], pricing: { byCategory: { marketing: { volume: 120, ratePerMessage: 0.0712 } }, totalCost: 7.97, currency: 'EUR' } });
    if (/\/stats(\?|$)/.test(url)) return json({ contacts: [{ date: AUJ, count: 18 }], contactsActifs: [{ date: AUJ, count: 15 }], templates: { utility: [], marketing: [] }, exchanged: [], service: [], serviceParOrigine: { ia: 0, scenario: 0, humain: 0, indeterminee: 0 } });
    if (/\/campaigns$/.test(chemin)) return json({ campaigns: CAMPAIGNS });
    if (/\/workflows\/wf1$/.test(chemin)) return json({ workflow: WF });
    if (/\/workflows$/.test(chemin)) return json({ workflows: [WF] });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [{ id: 'PN1', displayPhoneNumber: '+33 5 25 68 02 50' }] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/users')) return json({ users: [] });
    return json({});
  });
}

const TELEPHONE = { width: 390, height: 844 };

const ECRANS: Array<{ nom: string; chemin: string; accueil?: boolean; apres?: (page: Page) => Promise<void>; attendre: string }> = [
  { nom: 'Accueil', chemin: '/accueil', accueil: true, attendre: 'h1' },
  { nom: 'Inbox (liste)', chemin: '/inbox', attendre: '[data-testid="inbox-liste"]' },
  {
    nom: 'Inbox (fil ouvert)', chemin: '/inbox', attendre: '[data-testid="inbox-liste"]',
    apres: async (page) => {
      await page.getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).first().click();
      await expect(page.getByTestId('bouton-envoyer')).toBeVisible();
    },
  },
  { nom: 'Contacts', chemin: '/contacts', attendre: 'h1' },
  { nom: 'Campagnes', chemin: '/campaigns', attendre: 'h1' },
  { nom: 'Scénarios', chemin: '/workflows', attendre: 'h1' },
  { nom: 'Builder de scénario', chemin: '/workflows?open=wf1', attendre: '[data-testid="add-node-template"]' },
  { nom: 'Paramètres', chemin: '/parametres', attendre: '[data-testid="param-timezone"]' },
  { nom: 'Performance', chemin: '/performance', attendre: '[data-testid="carte-couts"]' },
  { nom: 'Sécurité > Consentement', chemin: '/securite/consentement', attendre: '[data-testid="desabonne-ligne"]' },
  { nom: 'Mon compte', chemin: '/compte', attendre: 'h1' },
];

test.describe('Mobile : aucune page ne déborde', () => {
  for (const e of ECRANS) {
    test(`🔴 ${e.nom} tient dans 390 px`, async ({ page }) => {
      await page.setViewportSize(TELEPHONE);
      if (e.accueil) await mockAccueil(page);
      else await monter(page);
      await page.goto(e.chemin);
      await expect(page.locator(e.attendre).first()).toBeVisible();
      if (e.apres) await e.apres(page);
      // ⚠️ SONDÉ, PAS LU UNE FOIS : le canevas du builder pose ses blocs AVANT de cadrer la vue, et déborde
      // quelques millisecondes pendant son premier rendu. Ce qu'on garde est l'état où la page se POSE.
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), {
        message: 'la page déborde horizontalement',
      }).toBeLessThanOrEqual(0);
    });
  }
});

test.describe('Le bouton d’aide ne recouvre pas « Envoyer »', () => {
  for (const vue of [{ nom: 'téléphone', taille: TELEPHONE }, { nom: 'ordinateur', taille: { width: 1440, height: 900 } }]) {
    test(`🔴 sur ${vue.nom}`, async ({ page }) => {
      await page.setViewportSize(vue.taille);
      await monter(page);
      await page.goto('/inbox');
      await page.getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).first().click();
      const envoyer = await page.getByTestId('bouton-envoyer').boundingBox();
      const aide = await page.getByTestId('aide-bouton').boundingBox();
      expect(envoyer, 'le bouton Envoyer est introuvable').not.toBeNull();
      expect(aide, 'le bouton d’aide a disparu de l’Inbox').not.toBeNull();
      const a = aide!;
      const b = envoyer!;
      const recouvre = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(recouvre, 'le bouton d’aide recouvre « Envoyer »').toBe(false);
    });
  }
});
