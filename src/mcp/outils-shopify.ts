import { ficheOutilMcp } from '../../web/lib/partage/catalogue-mcp';
import type { DepsMcp, OutilMcp } from './outils';
import { RefusOutil } from './saisie';
import { MESSAGE_OPERATIONS_LOURDES } from '../auth/plafond-partage';
import { journaliser } from '../lib/journal';
import { DELAI_PANIER_DEFAUT, DELAI_PANIER_MAX, DELAI_PANIER_MIN, DONNEES_PAR_EVENEMENT, EVENEMENTS_DISPONIBLES } from '../shopify/donnees';
import {
  apercuImportClients, brancherMessage, connecterShopify, couperShopify, etatShopify, importerClients, IMPORT_MAX, type Issue,
} from '../shopify/gestion';

/**
 * LE CONNECTEUR SHOPIFY DEPUIS CLAUDE CODE (plan 2026-10-21, lot 1) : la skill `shopify` du plugin pilote la CLI de
 * Shopify chez le marchand (création et publication de l'app, lien d'installation, `app env show`), puis ces outils
 * gardent la boutique et branchent les messages. La MÊME gestion que la carte de la console (`src/shopify/gestion.ts`).
 *
 * 🔴 TOUS EXIGENT UNE PERSONNE NOMMÉE (OAuth) : l'affirmation du consentement des clients se signe, et une clé
 * `mcp:write` donnée à un agent qui lit des messages de clients ne doit ni brancher ni débrancher la boutique, ni en
 * importer les clients (lot 3).
 * Ouverts à toutes les offres (décision de Julien), Base comprise, qui n'a pas de console.
 */

function valeur<T>(r: Issue<T>): T {
  if (!r.ok) throw new RefusOutil(r.message);
  return r.valeur;
}

const evenements = EVENEMENTS_DISPONIBLES.map((e) => `${e} (${DONNEES_PAR_EVENEMENT[e].join(', ')})`).join('; ');

export const OUTILS_SHOPIFY: OutilMcp[] = [
  {
    ...ficheOutilMcp('connect_shopify'),
    fonction: null,
    description:
      'Connects the merchant\'s Shopify store to the workspace, with the app the shopify skill created in the merchant\'s '
      + 'own Shopify organization and installed on the store: store (the <name>.myshopify.com domain), client_id and '
      + 'client_secret (SHOPIFY_API_KEY and SHOPIFY_API_SECRET from shopify app env show). The connection is checked with '
      + 'Shopify before the secret is kept, encrypted; a refusal says what to do (for example click Install on the given '
      + 'link). Reconnecting replaces the secret. Counts toward the workspace\'s heavy operations.',
    annotations: { title: 'Connect a Shopify store', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    entree: {
      type: 'object',
      properties: {
        store: { type: 'string', minLength: 1, maxLength: 100, description: 'The store domain, <name>.myshopify.com.' },
        client_id: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$', description: 'The app client id (SHOPIFY_API_KEY).' },
        client_secret: { type: 'string', minLength: 1, maxLength: 200, description: 'The app client secret (SHOPIFY_API_SECRET).' },
      },
      required: ['store', 'client_id', 'client_secret'],
      additionalProperties: false,
    },
    async executer(deps: DepsMcp, tenantId, args, personne) {
      const c = await deps.couteux.consommer(tenantId);
      if (!c.accepte) throw new RefusOutil(`${MESSAGE_OPERATIONS_LOURDES} (réessayer dans ${Math.max(1, Math.ceil(c.attenteMs / 1000))} s)`);
      const vue = valeur(await connecterShopify(deps.shopify, tenantId, { boutique: args.store, clientId: args.client_id, secret: args.client_secret }, personne?.userId ?? null, 'claude_code'));
      journaliser('info', 'mcp_shopify_connectee', { tenantId, userId: personne?.userId ?? null, boutique: vue.domaine });
      return { store: vue.domaine, name: vue.nom, country: vue.pays, currency: vue.devise, state: vue.etat };
    },
  },
  {
    ...ficheOutilMcp('set_shopify_message'),
    fonction: null,
    description:
      'Sends an approved WhatsApp template when a Shopify event happens, or stops it: event, template, language, '
      + `variables (the Shopify data of {{1}}, {{2}}... in order, as many as the template has). Events and their data: ${evenements}. `
      + 'An order message must be a utility template, approved at Meta (create_template, then get_template_status); a '
      + 'checkout_abandoned reminder is a marketing template, sent once, delay_minutes after the checkout last changed and '
      + 'only if no order came out of it; it requires the merchant to affirm customer consent. Links '
      + 'go in the body, a URL button takes no variable. One message per event: setting it again replaces it. '
      + 'customers_consented: true records that the merchant affirms its customers agreed to receive WhatsApp messages; the '
      + 'customers\' records then become opted in everywhere, campaigns included, and the merchant is responsible for it; '
      + 'false withdraws it (records already opted in stay so), and every new connect_shopify clears it. '
      + 'Every message goes through the sends rules (STOP, consent, monthly templates, contact limit) and appears in Campaigns.',
    annotations: { title: 'Set a Shopify message', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    entree: {
      type: 'object',
      properties: {
        event: { type: 'string', enum: [...EVENEMENTS_DISPONIBLES], description: 'The Shopify event.' },
        template: { type: 'string', minLength: 1, maxLength: 512, description: 'The template name.' },
        language: { type: 'string', minLength: 1, maxLength: 20, description: 'The template language (fr, en_US...).' },
        variables: {
          type: 'array', maxItems: 10, items: { type: 'string', enum: [...new Set(EVENEMENTS_DISPONIBLES.flatMap((e) => DONNEES_PAR_EVENEMENT[e]))] },
          description: 'The Shopify data of {{1}}, {{2}}..., in order.',
        },
        active: { type: 'boolean', description: 'false stops the message (default true).' },
        customers_consented: { type: 'boolean', description: 'The merchant affirms its customers agreed to receive WhatsApp messages.' },
        delay_minutes: {
          type: 'integer', minimum: DELAI_PANIER_MIN, maximum: DELAI_PANIER_MAX,
          description: `checkout_abandoned only: minutes after the checkout last changed (default ${DELAI_PANIER_DEFAUT}).`,
        },
      },
      required: ['event', 'template', 'language'],
      additionalProperties: false,
    },
    async executer(deps: DepsMcp, tenantId, args, personne) {
      const messages = valeur(await brancherMessage(deps.shopify, tenantId, {
        evenement: args.event, modele: args.template, langue: args.language, variables: args.variables, actif: args.active,
        delaiMinutes: args.delay_minutes,
        consentementAffirme: args.customers_consented,
      }, personne?.userId ?? null));
      journaliser('info', 'mcp_shopify_message', {
        tenantId, userId: personne?.userId ?? null, evenement: args.event, consentementAffirme: args.customers_consented === true,
      });
      return {
        messages: messages.map((m) => ({ event: m.evenement, template: m.modele, language: m.langue, variables: m.variables, active: m.actif })),
        ...(args.customers_consented === false
          ? { consentement: 'retiré : plus aucune fiche ne sera écrite consentante ; celles qui le sont déjà le restent' }
          : {}),
      };
    },
  },
  {
    ...ficheOutilMcp('get_shopify_state'),
    fonction: null,
    description:
      'The Shopify store connected to the workspace: its state (connected or cut), the messages set on its events, the last '
      + 'event received, whether the merchant affirmed customer consent, and the last 30 days of events by outcome (sent, '
      + 'opted out, without consent, contact limit, monthly templates limit, without phone...), and the abandoned checkouts: '
      + 'their delay and, over the last 7 days, the reminders sent, those closed in time by an order, those waiting.',
    annotations: { title: 'Get the Shopify connection', readOnlyHint: true, openWorldHint: false },
    entree: { type: 'object', properties: {} },
    async executer(deps: DepsMcp, tenantId) {
      const e = await etatShopify(deps.shopify, tenantId);
      if (e.boutique === null) return { connected: false, next_step: 'run the shopify skill of the Messaging Me plugin, then connect_shopify' };
      return {
        connected: e.boutique.etat === 'connectee',
        store: e.boutique.domaine, name: e.boutique.nom, state: e.boutique.etat, cut_reason: e.boutique.motifCoupure,
        last_event_at: e.boutique.dernierEvenementLe, customers_consented_at: e.boutique.consentement?.le ?? null,
        messages: e.messages.map((m) => ({ event: m.evenement, template: m.modele, language: m.langue, variables: m.variables, active: m.actif })),
        last_30_days: e.compteurs,
        checkouts: {
          delay_minutes: e.boutique.delaiPanierMinutes, reminders_last_7_days: e.paniers.relances,
          closed_in_time: e.paniers.fermesATemps, waiting: e.paniers.enAttente,
        },
        store_apps_page: e.pageApps,
      };
    },
  },
  {
    ...ficheOutilMcp('preview_shopify_customers'),
    fonction: null,
    description:
      'Counts, before any import, the customers of the connected Shopify store who subscribed to marketing (email or '
      + 'SMS) and have a valid phone: how many are already in the workspace, how many are new, how many free places the '
      + 'plan leaves (null when unlimited), and how many an import would write (importable, newest first). Writes nothing: '
      + 'the numbers the merchant chooses from (up to the free places, or a higher plan) before import_shopify_customers. '
      + 'Counts toward the workspace\'s heavy operations.',
    annotations: { title: 'Count the Shopify customers to import', readOnlyHint: true, openWorldHint: true },
    entree: { type: 'object', properties: {} },
    async executer(deps: DepsMcp, tenantId) {
      const c = await deps.couteux.consommer(tenantId);
      if (!c.accepte) throw new RefusOutil(`${MESSAGE_OPERATIONS_LOURDES} (réessayer dans ${Math.max(1, Math.ceil(c.attenteMs / 1000))} s)`);
      const a = valeur(await apercuImportClients(deps.shopify, tenantId));
      return {
        subscribed_with_phone: a.abonnes, subscribed_without_phone: a.sansTelephone, already_in_workspace: a.dejaDansLEspace,
        new: a.nouveaux, free_places: a.placesLibres, importable: a.importables, complete: a.complet,
      };
    },
  },
  {
    ...ficheOutilMcp('import_shopify_customers'),
    fonction: null,
    description:
      'Imports the newest max_contacts customers of the connected Shopify store who subscribed to marketing (email or SMS), '
      + 'have a valid phone and are not in the workspace yet, as the number the user chose after preview_shopify_customers. '
      + 'The records are tagged Shopify and carry NO WhatsApp consent: an email or SMS agreement is not a WhatsApp one, '
      + 'and a record that said STOP stays opted out. A max_contacts above the plan\'s free places is refused, nothing is '
      + `written halfway. At most ${IMPORT_MAX} per call; calling again imports the next ones without duplicates. `
      + 'Records already in the workspace are left untouched. Counts toward the workspace\'s heavy operations.',
    annotations: { title: 'Import the Shopify customers', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    entree: {
      type: 'object',
      properties: {
        max_contacts: { type: 'integer', minimum: 1, maximum: IMPORT_MAX, description: 'How many new subscribed customers to import, newest first: the number the user chose.' },
      },
      required: ['max_contacts'],
      additionalProperties: false,
    },
    async executer(deps: DepsMcp, tenantId, args, personne) {
      const c = await deps.couteux.consommer(tenantId);
      if (!c.accepte) throw new RefusOutil(`${MESSAGE_OPERATIONS_LOURDES} (réessayer dans ${Math.max(1, Math.ceil(c.attenteMs / 1000))} s)`);
      const b = valeur(await importerClients(deps.shopify, tenantId, args.max_contacts));
      journaliser('info', 'mcp_shopify_clients_importes', { tenantId, userId: personne?.userId ?? null, importes: b.importes, retablis: b.retablis });
      return {
        imported: b.importes, restored: b.retablis, left_out: b.restent, free_places_left: b.placesLibres, tag: b.etiquette,
        complete: b.complet, consent: 'none: the imported records are not opted in to WhatsApp',
      };
    },
  },
  {
    ...ficheOutilMcp('disconnect_shopify'),
    fonction: null,
    description:
      'Cuts the Shopify store: no message leaves anymore. The app stays installed on the store (only the merchant can '
      + 'uninstall it, from the store apps page this tool returns); the store\'s privacy requests are still honored. '
      + 'connect_shopify reconnects it.',
    annotations: { title: 'Disconnect the Shopify store', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    entree: { type: 'object', properties: {} },
    async executer(deps: DepsMcp, tenantId, _args, personne) {
      const r = valeur(await couperShopify(deps.shopify, tenantId));
      journaliser('info', 'mcp_shopify_coupee', { tenantId, userId: personne?.userId ?? null });
      return { cut: true, already_cut: r.dejaCoupee, store_apps_page: r.pageApps };
    },
  },
];
