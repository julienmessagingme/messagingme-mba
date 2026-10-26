import { test, expect, type Page } from './aide/test';

/**
 * LA CARTE SHOPIFY DE PARAMÈTRES > INTÉGRATIONS, vue de l'écran (conception 2026-10-22) : brancher une boutique depuis
 * la console, régler un message par l'assistant, sans repasser par Meta quand seul le délai change. Le serveur tient ses
 * règles de son côté (`tests/http-shopify.test.ts`, `tests/shopify-preparation.test.ts`) ; ici, on regarde ce que
 * l'écran MONTRE et ce qu'il ENVOIE, contre une API simulée.
 */
const BOUTIQUE = {
  domaine: 'ma-boutique.myshopify.com', nom: 'Ma Boutique', etat: 'connectee', dernierEvenementLe: null,
  delaiPanierMinutes: 60, origine: 'claude_code',
};
const VIDE = { boutique: null, messages: [], compteurs: {}, paniers: { relances: {}, fermesATemps: 0, enAttente: 0 }, pageApps: null, attentes: [] };
const BRANCHEE = {
  ...VIDE, boutique: BOUTIQUE, pageApps: 'https://admin.shopify.com/store/ma-boutique/settings/apps',
  messages: [{ evenement: 'order_paid', modele: 'confirmation_commande', langue: 'fr', variables: ['first_name', 'order_number'], actif: true }],
};
/** La relance aussi active : son modèle est relu chez Meta comme celui de la commande. */
const RELANCE_ACTIVE = {
  ...BRANCHEE,
  messages: [...BRANCHEE.messages, { evenement: 'checkout_abandoned', modele: 'relance_panier', langue: 'fr', variables: ['checkout_url'], actif: true }],
};

interface Trace { branchements: unknown[]; preparations: unknown[]; reglages: Array<{ evenement: string; corps: unknown }> }

async function monter(page: Page, o: { etat?: Record<string, unknown> | 'absente'; apresBranchement?: Record<string, unknown> }): Promise<Trace> {
  const trace: Trace = { branchements: [], preparations: [], reglages: [] };
  const session = { token: 'e2e-token', email: 'moi@e2e.test', role: 'admin', tenantId: 't-e2e' };
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), session);
  let etat = o.etat ?? BRANCHEE;
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = req.url().split('?')[0]!;
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    const reglage = /\/integrations\/shopify\/messages\/([a-z_]+)$/.exec(chemin);
    if (reglage && req.method() === 'PATCH') {
      trace.reglages.push({ evenement: reglage[1]!, corps: req.postDataJSON() });
      return json({});
    }
    if (chemin.endsWith('/integrations/shopify/messages') && req.method() === 'POST') {
      trace.preparations.push(req.postDataJSON());
      return json({ etat: 'en_validation', modele: 'shopify_checkout_abandoned_x' });
    }
    if (chemin.endsWith('/integrations/shopify') && req.method() === 'POST') {
      trace.branchements.push(req.postDataJSON());
      if (o.apresBranchement) etat = o.apresBranchement;
      return json(BOUTIQUE);
    }
    if (chemin.endsWith('/integrations/shopify')) {
      // Le 404 exact du routeur Fastify : c'est lui qui dit « API pas encore déployée ».
      if (etat === 'absente') return json({ message: 'Route GET not found', error: 'Not Found', statusCode: 404 }, 404);
      return json(etat);
    }
    if (chemin.endsWith('/templates')) {
      return json({ templates: [
        { id: '1', name: 'confirmation_commande', status: 'APPROVED', category: 'UTILITY', language: 'fr', body: 'Bonjour {{1}}, votre commande {{2}} est bien payée. Merci !', isCarousel: false },
        { id: '2', name: 'relance_panier', status: 'APPROVED', category: 'MARKETING', language: 'fr', body: 'Votre panier vous attend : {{1}} À très vite !', isCarousel: false },
      ] });
    }
    if (chemin.endsWith('/settings')) return json({ mbaEnabled: false, timezone: 'Europe/Paris', businessHours: {} });
    if (chemin.endsWith('/account-status')) return json({ hasNumber: false, hubspotPortal: { connected: false } });
    if (chemin.endsWith('/integrations/batch')) return json({ branche: false });
    if (chemin.endsWith('/settings/agents-peuvent-prendre')) return json({ actif: false });
    if (chemin.endsWith('/contacts/blocked')) return json({ contacts: [] });
    if (chemin.endsWith('/unread-count')) return json({ count: 0 });
    if (chemin.endsWith('/me')) return json({ email: 'moi@e2e.test', name: 'Moi', role: 'admin' });
    return json({});
  });
  await page.goto('/integrations');
  return trace;
}

test.describe('Tools > Intégrations > Shopify : la carte de la console', () => {
  test('🔴 sans boutique : le mode opératoire, puis les clés branchent la boutique, nettoyées', async ({ page }) => {
    const trace = await monter(page, { etat: VIDE, apresBranchement: BRANCHEE });
    const carte = page.getByTestId('integration-shopify');
    await expect(carte.getByTestId('shopify-mode-operatoire')).toContainText('Create app manually');
    await expect(carte.getByTestId('shopify-mode-operatoire')).toContainText('https://app.messagingme.fr/shopify/console/');
    await expect(carte.getByTestId('shopify-mode-operatoire')).toContainText('read_customers,read_orders,read_checkouts,read_fulfillments');
    const valider = carte.getByTestId('shopify-brancher-valider');
    await expect(valider).toBeDisabled();
    await carte.getByTestId('shopify-boutique').fill(' https://admin.shopify.com/store/ma-boutique ');
    await carte.getByTestId('shopify-client-id').fill(' cid ');
    await carte.getByTestId('shopify-secret').fill('shpss_secret\n');
    await valider.click();
    await expect.poll(() => trace.branchements.length).toBe(1);
    expect(trace.branchements[0]).toEqual({ boutique: 'https://admin.shopify.com/store/ma-boutique', clientId: 'cid', secret: 'shpss_secret' });
    await expect(carte.getByTestId('integration-shopify-messages')).toBeVisible();
    await expect(carte.getByTestId('integration-shopify-message')).toContainText('Boutique branchée');
  });

  test('🔴 la relance : texte proposé à repères, délai, puis le corps envoyé au serveur, sans aucune question du consentement', async ({ page }) => {
    const trace = await monter(page, {});
    await expect(page.getByTestId('integration-shopify-message-checkout_abandoned')).toContainText('pas encore réglé');
    await page.getByTestId('integration-shopify-regler-checkout_abandoned').click();
    const assistant = page.getByTestId('shopify-assistant');
    // Le texte proposé de la relance n'a pas de prénom (facultatif chez Shopify, décision du 2026-10-23).
    await expect(assistant.getByTestId('shopify-assistant-texte')).toHaveValue(/^Bonjour, vous avez laissé.*\n.*\{lien du panier\}/);
    // L'aperçu WhatsApp montre les valeurs d'exemple, et le pied STOP de la relance.
    await expect(assistant).toContainText('Il vous attend ici : https://ma-boutique.myshopify.com/checkouts/recover');
    await expect(assistant.getByTestId('shopify-assistant-prenom-secours')).toHaveCount(0);
    await expect(assistant).toContainText('Répondez STOP pour ne plus recevoir ces messages');
    await assistant.getByTestId('shopify-assistant-suivant').click();
    await assistant.getByTestId('shopify-delai-15').click();
    // Le délai est la dernière étape (2026-10-26) : aucune case à cocher avant d'envoyer.
    await expect(assistant).toContainText('Étape 2 sur 2');
    await expect(assistant.getByTestId('shopify-assistant-suivant')).toHaveCount(0);
    await assistant.getByTestId('shopify-assistant-envoyer').click();
    await expect.poll(() => trace.preparations.length).toBe(1);
    expect(trace.preparations[0]).toEqual({
      evenement: 'checkout_abandoned', langue: 'fr', delaiMinutes: 15,
      texte: 'Bonjour, vous avez laissé des articles dans votre panier.\nIl vous attend ici : {{checkout_url}}\nÀ très vite !',
    });
    await expect(page.getByTestId('integration-shopify-message')).toContainText('Envoyé à Meta');
  });

  test('un repère inconnu, ou un texte qui finit par une donnée, est dit avant l’envoi', async ({ page }) => {
    const trace = await monter(page, {});
    await page.getByTestId('integration-shopify-regler-checkout_abandoned').click();
    const assistant = page.getByTestId('shopify-assistant');
    await assistant.getByTestId('shopify-assistant-texte').fill('Bonjour {prenon}, votre panier : {lien du panier} merci');
    await assistant.getByTestId('shopify-assistant-suivant').click();
    await expect(assistant.getByTestId('shopify-assistant-erreur')).toContainText('{prenon}');
    await assistant.getByTestId('shopify-assistant-texte').fill('Bonjour, votre panier : {lien du panier}');
    await assistant.getByTestId('shopify-assistant-suivant').click();
    await expect(assistant.getByTestId('shopify-assistant-erreur')).toContainText('ni commencer ni finir');
    expect(trace.preparations).toEqual([]);
  });

  test('🔴 un message de commande n’a que son texte : inchangé, rien à enregistrer ; modifié, il part chez Meta', async ({ page }) => {
    const trace = await monter(page, {});
    await expect(page.getByTestId('integration-shopify-message-order_paid')).toContainText('actif');
    await page.getByTestId('integration-shopify-regler-order_paid').click();
    const assistant = page.getByTestId('shopify-assistant');
    // Le texte du modèle en place, relu chez Meta, avec les repères du marchand.
    const texte = assistant.getByTestId('shopify-assistant-texte');
    await expect(texte).toHaveValue('Bonjour {prénom}, votre commande {numéro de commande} est bien payée. Merci !');
    // Un texte avec le prénom : l'assistant dit ce que le message écrit quand Shopify ne l'a pas.
    await expect(assistant.getByTestId('shopify-assistant-prenom-secours')).toContainText('à vous');
    // Une seule étape, et plus aucune case du consentement (2026-10-26).
    await expect(assistant.getByTestId('shopify-assistant-suivant')).toHaveCount(0);
    const envoyer = assistant.getByTestId('shopify-assistant-envoyer');
    await expect(envoyer).toBeDisabled();
    await expect(assistant.getByTestId('shopify-assistant-inchange')).toBeVisible();
    await texte.fill('Bonjour {prénom}, votre commande {numéro de commande} est payée. Merci !');
    await expect(assistant.getByTestId('shopify-assistant-inchange')).toHaveCount(0);
    await envoyer.click();
    await expect.poll(() => trace.preparations.length).toBe(1);
    expect(trace.preparations[0]).toEqual({ evenement: 'order_paid', langue: 'fr', texte: 'Bonjour {{first_name}}, votre commande {{order_number}} est payée. Merci !' });
    expect(trace.reglages).toEqual([]);
  });

  test('🔴 un message de commande au texte refusé : l’erreur est dite à l’envoi, rien ne part', async ({ page }) => {
    const trace = await monter(page, {});
    await page.getByTestId('integration-shopify-regler-order_paid').click();
    const assistant = page.getByTestId('shopify-assistant');
    await expect(assistant.getByTestId('shopify-assistant-texte')).toHaveValue(/Merci !$/);
    await assistant.getByTestId('shopify-assistant-texte').fill('Bonjour {prenon}, votre commande {numéro de commande} est payée');
    await assistant.getByTestId('shopify-assistant-envoyer').click();
    await expect(assistant.getByTestId('shopify-assistant-erreur')).toContainText('{prenon}');
    expect(trace.preparations).toEqual([]);
  });

  test('🔴 une relance active dont seul le délai change : réglée tout de suite, sans repasser par Meta', async ({ page }) => {
    const trace = await monter(page, { etat: RELANCE_ACTIVE });
    await expect(page.getByTestId('integration-shopify-message-checkout_abandoned')).toContainText('actif');
    await page.getByTestId('integration-shopify-regler-checkout_abandoned').click();
    const assistant = page.getByTestId('shopify-assistant');
    await expect(assistant.getByTestId('shopify-assistant-texte')).toHaveValue('Votre panier vous attend : {lien du panier} À très vite !');
    await assistant.getByTestId('shopify-assistant-suivant').click();
    await assistant.getByTestId('shopify-delai-15').click();
    const enregistrer = assistant.getByTestId('shopify-assistant-envoyer');
    await expect(enregistrer).toHaveText('Enregistrer');
    await enregistrer.click();
    await expect.poll(() => trace.reglages.length).toBe(1);
    expect(trace.reglages[0]).toEqual({ evenement: 'checkout_abandoned', corps: { delaiMinutes: 15 } });
    expect(trace.preparations).toEqual([]);
  });

  test('🔴 API pas encore déployée (404 du routeur) : AUCUNE carte', async ({ page }) => {
    await monter(page, { etat: 'absente' });
    await expect(page.getByTestId('integration-hubspot')).toBeVisible();
    await expect(page.getByTestId('integration-shopify')).toHaveCount(0);
  });
});
