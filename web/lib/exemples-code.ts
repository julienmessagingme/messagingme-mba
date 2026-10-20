// web/lib/exemples-code.ts
import type { Bilingue } from './api-exemples';

/**
 * LE CODE QUE LA DOC MONTRE ET QU'UN TEST COMPILE (lot 17) : les exemples de la page SDK et la recette Next.js.
 *
 * 🔴 `tests/doc-exemples-compiles.test.ts` écrit chaque fichier dans un projet temporaire et le compile contre `sdk/src`
 * (le SDK tel qu'il est publié) : un exemple qui appelle une route, un champ ou une fonction qui n'existent pas rend la
 * CI rouge, au lieu d'être copié tel quel par un intégrateur ou par son assistant. Les pages AFFICHENT ces textes, elles
 * ne les recopient pas.
 *
 * `contexte` : des déclarations ajoutées pour la compilation seulement, jamais affichées (un fragment qui suppose un
 * client déjà créé). Le code des route handlers n'importe rien de Next : `Request` et `Response` standard, que Next
 * accepte tels quels, pour que le test n'ait besoin que du SDK.
 *
 * ⚠️ AUCUN IMPORT DE VALEUR : lu par le build de la console ET par la suite racine.
 */

/**
 * LA VERSION DU SDK QUE LA DOC FAIT INSTALLER (page SDK, recette Next.js, prompt). ⚠️ C'est celle de `sdk/package.json` :
 * `tests/sdk-contrat.test.ts` les compare, comme celle du README. Monter la version du SDK sans toucher cette ligne ferait
 * installer l'ancienne.
 */
export const VERSION_SDK = '0.3.1';

export interface ExempleCode {
  /** Le chemin du fichier dans le projet de l'intégrateur, affiché en légende ; aussi son chemin dans le projet de test. */
  readonly fichier: string;
  readonly code: string;
  readonly contexte?: string;
}

const lignes = (...l: string[]): string => l.join('\n');

/** Les exemples de la page SDK (repris de `sdk/README.md`). */
export const EXEMPLES_SDK = {
  premierAppel: {
    fichier: 'premier-appel.ts',
    code: lignes(
      "import { createClient } from '@messagingme/sdk';",
      '',
      'const api = createClient({ apiKey: process.env.MESSAGINGME_API_KEY! });',
      '',
      '// Créer une fiche, ou la mettre à jour si elle existe.',
      "const { contactId, status } = await api.POST('/v1/contacts', {",
      "  body: { phone: '+33612345678', name: 'Camille Roy', consent: 'opted_in', consentSource: 'formulaire-site' },",
      '});',
      '',
      '// Lire une fiche : les paramètres de chemin passent par path.',
      "const fiche = await api.GET('/v1/contacts/{contactId}', { path: { contactId } });",
      '',
      '// Les conversations qui attendent une réponse, par pages : query.',
      "const page = await api.GET('/v1/conversations', { query: { needsReply: true, limit: 20 } });",
      '',
      '// Un envoi, rejouable sans doublon avec la même clé d’idempotence. Ici un modèle sans variable :',
      '// avec variables, ajoutez params (voir Envois).',
      "const envoi = await api.POST('/v1/sends', {",
      '  body: {',
      "    target: { template: { name: 'bienvenue', language: 'fr' } },",
      "    recipients: [{ phone: '+33612345678' }],",
      '  },',
      "  idempotencyKey: 'commande-7781',",
      '});',
    ),
  },
  erreurs: {
    fichier: 'erreurs.ts',
    contexte: lignes("import type { Client } from '@messagingme/sdk';", 'declare const api: Client;', 'declare const contactId: string;'),
    code: lignes(
      "import { ApiError } from '@messagingme/sdk';",
      '',
      'try {',
      "  await api.POST('/v1/messages/whatsapp', { body: { contactId, text: 'Bonjour' } });",
      '} catch (e) {',
      '  if (e instanceof ApiError) {',
      "    if (e.code === 'window_closed') { /* la personne n’a pas écrit depuis 24 h : passer par un modèle */ }",
      "    if (e.code === 'meta_rejected') { /* Meta a refusé : e.metaCode dit pourquoi (131047, 132000…) */ }",
      '    if (e.status === 429 && e.retryAfter !== null) { /* attendre e.retryAfter secondes */ }',
      '  }',
      '  throw e;',
      '}',
    ),
  },
  webhook: {
    fichier: 'webhook.ts',
    code: lignes(
      "import { verifyWebhook, WebhookVerificationError } from '@messagingme/sdk';",
      '',
      '// Une route qui reçoit les webhooks sortants (ici avec l’API Request standard).',
      'export async function POST(req: Request) {',
      '  const body = await req.text();',
      '  try {',
      '    const event = await verifyWebhook({ secret: process.env.MESSAGINGME_WEBHOOK_SECRET!, headers: req.headers, body });',
      "    if (event.type === 'message.received') console.log(event.data.text);",
      '    return new Response(null, { status: 204 });',
      '  } catch (e) {',
      '    if (e instanceof WebhookVerificationError) return new Response(null, { status: 401 });',
      '    throw e;',
      '  }',
      '}',
    ),
  },
} as const satisfies Record<string, ExempleCode>;

/** La recette Next.js (App Router) : le client, une route qui envoie un modèle, une route qui reçoit les webhooks. */
export const RECETTE_NEXTJS = {
  client: {
    fichier: 'lib/messagingme.ts',
    code: lignes(
      "import { createClient } from '@messagingme/sdk';",
      '',
      '// Côté serveur seulement : la clé ne doit jamais partir dans le navigateur (pas de NEXT_PUBLIC_).',
      'export const messagingme = createClient({ apiKey: process.env.MESSAGINGME_API_KEY! });',
    ),
  },
  envoi: {
    fichier: 'app/api/confirmation/route.ts',
    code: lignes(
      "import { ApiError } from '@messagingme/sdk';",
      "import { messagingme } from '../../../lib/messagingme';",
      '',
      '// POST /api/confirmation, avec phone (au format +33…) et commande dans le corps JSON.',
      'export async function POST(req: Request) {',
      '  const { phone, commande } = (await req.json()) as { phone?: unknown; commande?: unknown };',
      "  if (typeof phone !== 'string' || typeof commande !== 'string') {",
      "    return Response.json({ error: 'phone et commande requis' }, { status: 400 });",
      '  }',
      '  try {',
      "    const envoi = await messagingme.POST('/v1/sends', {",
      '      body: {',
      '        // Le modèle a deux variables : le nom du contact, puis le numéro de commande.',
      "        target: { template: { name: 'confirmation_commande', language: 'fr' } },",
      '        recipients: [{ phone, variables: { commande } }],',
      '        params: [',
      "          { position: 1, source: { type: 'attribute', key: 'name' }, fallback: 'Bonjour' },",
      "          { position: 2, source: { type: 'variable', key: 'commande' } },",
      '        ],',
      '      },',
      '      // Rappelée avec la même commande pendant 24 h, la route ne renvoie pas le message.',
      '      idempotencyKey: `commande-${commande}`,',
      '    });',
      '    return Response.json({ sendId: envoi.sendId, skipped: envoi.skipped });',
      '  } catch (e) {',
      '    if (e instanceof ApiError) {',
      '      // e.code est stable (voir le catalogue des erreurs) ; e.metaCode porte le numéro de Meta sur meta_rejected.',
      '      return Response.json({ code: e.code, metaCode: e.metaCode, error: e.message }, { status: e.status });',
      '    }',
      '    throw e;',
      '  }',
      '}',
    ),
  },
  webhook: {
    fichier: 'app/api/webhooks/messagingme/route.ts',
    code: lignes(
      "import { verifyWebhook, WebhookVerificationError } from '@messagingme/sdk';",
      '',
      'export async function POST(req: Request) {',
      '  // Le corps BRUT : la signature porte sur ses octets.',
      '  const body = await req.text();',
      '  let event;',
      '  try {',
      '    event = await verifyWebhook({ secret: process.env.MESSAGINGME_WEBHOOK_SECRET!, headers: req.headers, body });',
      '  } catch (e) {',
      '    if (e instanceof WebhookVerificationError) return new Response(null, { status: 401 });',
      '    throw e;',
      '  }',
      '  // Un même événement peut arriver deux fois : dédoublonnez par event.id.',
      "  if (event.type === 'message.received') console.log('reçu', event.data.contact, event.data.text);",
      "  if (event.type === 'message.failed') console.warn('échec', event.data.meta_code, event.data.reason);",
      '  // Répondre vite (moins de 10 s) : un traitement long se fait après, sinon le webhook est réessayé.',
      '  return new Response(null, { status: 204 });',
      '}',
    ),
  },
} as const satisfies Record<string, ExempleCode>;

/** Le client des cas d'usage, en anglais comme tout leur code (il se lit sur GitHub, dans le dossier de la commande). */
const CLIENT_EN: ExempleCode = {
  fichier: 'lib/messagingme.ts',
  code: lignes(
    "import { createClient } from '@messagingme/sdk';",
    '',
    '// Server side only: the key must never reach the browser (no NEXT_PUBLIC_ prefix).',
    'export const messagingme = createClient({ apiKey: process.env.MESSAGINGME_API_KEY! });',
  ),
};

/**
 * Le code des cas d'usage (lots 6 et 6 bis), par clé du registre (`web/lib/registre-vitrine.ts`) puis par partie, comme
 * `RECETTE_NEXTJS`. Écrit une fois : le guide l'affiche, la page de la vitrine en montre un extrait
 * (`data-exemple="cas.<clé>.<partie>"`), et `npm run plugin:generer` le recopie dans le dossier de la commande du
 * plugin. `tests/doc-exemples-compiles.test.ts` compile chaque cas dans SON dossier, contre le SDK publié. Commentaires
 * en anglais : ce code se lit aussi sur GitHub.
 */
export const EXEMPLES_CAS = {
  rappels: {
    client: CLIENT_EN,
    agenda: {
      fichier: 'lib/calendar.ts',
      code: lignes(
        '// What this case needs from your calendar: Claude Code wires these functions to your own database.',
        'export interface Appointment {',
        '  id: string;',
        '  phone: string; // E.164: +33612345678',
        '  firstName: string;',
        "  time: string; // as the patient reads it: '10:30 AM'",
        '}',
        '',
        "const todo = (what: string): never => { throw new Error(`lib/calendar.ts: ${what} is not connected yet`); };",
        '',
        "/** Tomorrow's appointments: the ones to remind tonight. */",
        "export async function tomorrowsAppointments(): Promise<Appointment[]> { return todo('tomorrowsAppointments'); }",
        '/** Remembers the reminder sent to this number: a button reply does not say which message it answers. */',
        "export async function saveReminder(appointment: Appointment, sendId: string): Promise<void> { return todo('saveReminder'); }",
        '/** The last reminder sent to this number, or null. */',
        "export async function lastReminder(phone: string): Promise<Appointment | null> { return todo('lastReminder'); }",
        "export async function markConfirmed(appointment: Appointment): Promise<void> { return todo('markConfirmed'); }",
        '/** A few free slots, written as the WhatsApp message that offers them. */',
        "export async function freeSlots(appointment: Appointment, count: number): Promise<string> { return todo('freeSlots'); }",
        '/** Moves the appointment to the chosen slot (twice the same slot moves it once), and returns the confirmation. */',
        "export async function move(appointment: Appointment, slot: string): Promise<string> { return todo('move'); }",
      ),
    },
    tache: {
      fichier: 'jobs/reminders.ts',
      code: lignes(
        "import { messagingme } from '../lib/messagingme';",
        "import { saveReminder, tomorrowsAppointments } from '../lib/calendar';",
        '',
        '// Run once a day, the evening before (a cron of your host). The template appointment_reminder has two variables,',
        '// the first name then the time, and two quick reply buttons: Confirm and Reschedule.',
        'export async function dayBeforeReminders(): Promise<void> {',
        '  for (const appointment of await tomorrowsAppointments()) {',
        "    const send = await messagingme.POST('/v1/sends', {",
        '      body: {',
        "        target: { template: { name: 'appointment_reminder', language: 'en' } },",
        '        recipients: [{ phone: appointment.phone, variables: { firstName: appointment.firstName, time: appointment.time } }],',
        '        params: [',
        "          { position: 1, source: { type: 'variable', key: 'firstName' } },",
        "          { position: 2, source: { type: 'variable', key: 'time' } },",
        '        ],',
        '      },',
        '      // Run twice for the same appointment, the job does not send twice.',
        '      idempotencyKey: `reminder-${appointment.id}`,',
        '    });',
        '    await saveReminder(appointment, send.sendId);',
        '  }',
        '}',
      ),
    },
    webhook: {
      fichier: 'app/api/webhooks/messagingme/route.ts',
      code: lignes(
        "import { verifyWebhook, WebhookVerificationError } from '@messagingme/sdk';",
        "import { messagingme } from '../../../../lib/messagingme';",
        "import { freeSlots, lastReminder, markConfirmed, move } from '../../../../lib/calendar';",
        '',
        '// Subscribed to message.received (the Confirm button) and agent.action (the AI agent’s two actions,',
        '// Reschedule request and Slot choice). Both types are unchecked by default on a webhook address.',
        'export async function POST(req: Request) {',
        '  // The RAW body: the signature covers its bytes.',
        '  const body = await req.text();',
        '  let event;',
        '  try {',
        '    event = await verifyWebhook({ secret: process.env.MESSAGINGME_WEBHOOK_SECRET!, headers: req.headers, body });',
        '  } catch (e) {',
        '    if (e instanceof WebhookVerificationError) return new Response(null, { status: 401 });',
        '    throw e;',
        '  }',
        "  if (event.type !== 'message.received' && event.type !== 'agent.action') return new Response(null, { status: 204 });",
        '  const contact = event.data.contact;',
        '  // A button reply carries its label only, not the message it answers: tie it to the last reminder of the number.',
        '  const appointment = contact?.phone ? await lastReminder(contact.phone) : null;',
        '  if (!contact || !appointment) return new Response(null, { status: 204 });',
        "  if (event.type === 'message.received' && event.data.button === 'Confirm') await markConfirmed(appointment);",
        "  if (event.type === 'agent.action') {",
        '    const { action, fields } = event.data;',
        '    let text: string | null = null;',
        "    if (action.name === 'Reschedule request') text = await freeSlots(appointment, 3);",
        "    if (action.name === 'Slot choice' && fields.slot !== undefined) text = await move(appointment, String(fields.slot));",
        "    if (text) await messagingme.POST('/v1/messages/whatsapp', { body: { contactId: contact.id, text } });",
        '  }',
        '  // Answer fast (under 10 s): a slow job runs after, otherwise the webhook is retried.',
        '  return new Response(null, { status: 204 });',
        '}',
      ),
    },
  },
  'rendez-vous': {
    client: CLIENT_EN,
    agenda: {
      fichier: 'lib/calendar.ts',
      code: lignes(
        '// What this case needs from your calendar: Claude Code wires these functions to your own database.',
        "const todo = (what: string): never => { throw new Error(`lib/calendar.ts: ${what} is not connected yet`); };",
        '',
        '/** A few free slots near this city, written as the WhatsApp message that offers them. */',
        "export async function offerSlots(city: string, count: number): Promise<string> { return todo('offerSlots'); }",
        '/** Books the chosen slot once per request (the same event twice books once), and returns the confirmation. */',
        "export async function book(requestId: string, slot: string): Promise<string> { return todo('book'); }",
      ),
    },
    webhook: {
      fichier: 'app/api/webhooks/messagingme/route.ts',
      code: lignes(
        "import { verifyWebhook, WebhookVerificationError } from '@messagingme/sdk';",
        "import { messagingme } from '../../../../lib/messagingme';",
        "import { book, offerSlots } from '../../../../lib/calendar';",
        '',
        '// Subscribed to agent.action: the AI agent’s two actions, Appointment request (fields reason and city) and Slot',
        '// choice (field slot). The type is unchecked by default on a webhook address.',
        'export async function POST(req: Request) {',
        '  // The RAW body: the signature covers its bytes.',
        '  const body = await req.text();',
        '  let event;',
        '  try {',
        '    event = await verifyWebhook({ secret: process.env.MESSAGINGME_WEBHOOK_SECRET!, headers: req.headers, body });',
        '  } catch (e) {',
        '    if (e instanceof WebhookVerificationError) return new Response(null, { status: 401 });',
        '    throw e;',
        '  }',
        "  if (event.type !== 'agent.action' || !event.data.contact) return new Response(null, { status: 204 });",
        '  const { action, fields, contact } = event.data;',
        '  let text: string | null = null;',
        "  if (action.name === 'Appointment request') text = await offerSlots(String(fields.city ?? ''), 3);",
        "  if (action.name === 'Slot choice' && fields.slot !== undefined) text = await book(event.id, String(fields.slot));",
        "  if (text) await messagingme.POST('/v1/messages/whatsapp', { body: { contactId: contact.id, text } });",
        '  // Answer fast (under 10 s): a slow job runs after, otherwise the webhook is retried.',
        '  return new Response(null, { status: 204 });',
        '}',
      ),
    },
  },
  notifications: {
    client: CLIENT_EN,
    commandes: {
      fichier: 'lib/orders.ts',
      code: lignes(
        "import { messagingme } from './messagingme';",
        '',
        '// What this case needs from your orders: Claude Code wires these two functions to your own database.',
        "const todo = (what: string): never => { throw new Error(`lib/orders.ts: ${what} is not connected yet`); };",
        "export async function saveSendId(orderId: string, sendId: string): Promise<void> { return todo('saveSendId'); }",
        "export async function setWhatsappStatus(sendId: string, status: 'delivered' | 'read'): Promise<void> { return todo('setWhatsappStatus'); }",
        '',
        '// Call it when an order moves to shipped. The template order_shipped has two variables, the first name then the',
        '// order number, and a URL button to your tracking page.',
        'export async function notifyShipped(order: { id: string; phone: string; firstName: string }): Promise<void> {',
        "  const send = await messagingme.POST('/v1/sends', {",
        '    body: {',
        "      target: { template: { name: 'order_shipped', language: 'en' } },",
        '      recipients: [{ phone: order.phone, variables: { firstName: order.firstName, order: order.id } }],',
        '      params: [',
        "        { position: 1, source: { type: 'variable', key: 'firstName' } },",
        "        { position: 2, source: { type: 'variable', key: 'order' } },",
        '      ],',
        '    },',
        '    // Replayed within 24 hours (the life of the key), the shipment does not send twice.',
        '    idempotencyKey: `shipped-${order.id}`,',
        '  });',
        '  // The delivery and read receipts carry this sendId: it ties them back to the order.',
        '  await saveSendId(order.id, send.sendId);',
        '}',
      ),
    },
    webhook: {
      fichier: 'app/api/webhooks/messagingme/route.ts',
      code: lignes(
        "import { verifyWebhook, WebhookVerificationError } from '@messagingme/sdk';",
        "import { setWhatsappStatus } from '../../../../lib/orders';",
        '',
        '// Subscribed to message.delivered and message.read, both unchecked by default on a webhook address.',
        'export async function POST(req: Request) {',
        '  // The RAW body: the signature covers its bytes.',
        '  const body = await req.text();',
        '  let event;',
        '  try {',
        '    event = await verifyWebhook({ secret: process.env.MESSAGINGME_WEBHOOK_SECRET!, headers: req.headers, body });',
        '  } catch (e) {',
        '    if (e instanceof WebhookVerificationError) return new Response(null, { status: 401 });',
        '    throw e;',
        '  }',
        "  if ((event.type === 'message.delivered' || event.type === 'message.read') && event.data.send_id) {",
        "    await setWhatsappStatus(event.data.send_id, event.type === 'message.read' ? 'read' : 'delivered');",
        '  }',
        '  return new Response(null, { status: 204 });',
        '}',
      ),
    },
  },
} as const satisfies Record<string, Record<string, ExempleCode>>;

/** Les variables d'environnement de la recette (`.env.local`), jamais compilées. */
export const ENV_NEXTJS = lignes('MESSAGINGME_API_KEY=mba_...', 'MESSAGINGME_WEBHOOK_SECRET=whsec_...');

/**
 * Le prompt à coller dans Claude Code, Cursor ou un autre assistant, dans un projet Next.js. Il renvoie l'assistant vers
 * la version `.md` de cette recette, que la doc publie pour les modèles.
 */
export const PROMPT_NEXTJS: Bilingue = [
  lignes(
    'Branche Messaging Me (WhatsApp) dans ce projet Next.js (App Router), en suivant la recette',
    'https://console.messagingme.app/developers/api/guides/nextjs.md :',
    '1. installe le SDK : npm install github:julienmessagingme/messagingme-sdk#v{VERSION} ;',
    '2. crée lib/messagingme.ts (le client, côté serveur seulement) ;',
    '3. crée la route POST /api/confirmation qui envoie le modèle « confirmation_commande » (deux variables : le nom',
    '   du contact, puis le numéro de commande) avec une clé d’idempotence tirée du numéro de commande, et renvoie',
    '   e.code et e.metaCode en cas d’erreur ;',
    '4. crée la route POST /api/webhooks/messagingme qui vérifie la signature avec verifyWebhook sur le corps brut',
    '   et répond 204 ;',
    '5. ajoute MESSAGINGME_API_KEY et MESSAGINGME_WEBHOOK_SECRET à .env.local, sans valeur réelle dans le code.',
    'N’invente aucune route ni aucun champ : ils sont dans https://api.messagingme.app/openapi.json.',
  ),
  lignes(
    'Connect Messaging Me (WhatsApp) to this Next.js project (App Router), following the recipe',
    'https://console.messagingme.app/developers/api/guides/nextjs.en.md:',
    '1. install the SDK: npm install github:julienmessagingme/messagingme-sdk#v{VERSION};',
    '2. create lib/messagingme.ts (the client, server-side only);',
    '3. create the POST /api/confirmation route that sends the “confirmation_commande” template (two variables: the',
    '   contact name, then the order number) with an idempotency key taken from the order number, and returns e.code and',
    '   e.metaCode on error;',
    '4. create the POST /api/webhooks/messagingme route that verifies the signature with verifyWebhook on the raw body',
    '   and answers 204;',
    '5. add MESSAGINGME_API_KEY and MESSAGINGME_WEBHOOK_SECRET to .env.local, with no real value in the code.',
    'Do not invent any route or field: they are in https://api.messagingme.app/openapi.json.',
  ),
];

/** Le prompt de la recette des rappels de rendez-vous (`EXEMPLES_CAS.rappels`), qui renvoie l'assistant vers sa version `.md`. */
export const PROMPT_RAPPELS: Bilingue = [
  lignes(
    'Branche des rappels de rendez-vous WhatsApp dans ce projet, en suivant la recette',
    'https://console.messagingme.app/developers/api/guides/appointment-reminders.md :',
    '1. installe le SDK : npm install github:julienmessagingme/messagingme-sdk#v{VERSION} ;',
    '2. avec les outils Messaging Me, crée le modèle de rappel (UTILITY, le prénom puis l’heure, deux boutons de réponse',
    '   rapide) et, sur l’agent qui répond, les deux actions « Reschedule request » (sans champ) et « Slot choice » (champ slot) ;',
    '3. écris lib/calendar.ts relié à notre agenda, jobs/reminders.ts (la tâche de la veille) et la route',
    '   app/api/webhooks/messagingme/route.ts, en gardant les mêmes libellés de boutons et noms d’actions partout ;',
    '4. abonne la route à message.received et agent.action, et range la clé et le secret dans les variables',
    '   d’environnement, jamais dans le code.',
    'N’invente aucune route ni aucun champ : ils sont dans https://api.messagingme.app/openapi.json.',
  ),
  lignes(
    'Add WhatsApp appointment reminders to this project, following the recipe',
    'https://console.messagingme.app/developers/api/guides/appointment-reminders.en.md:',
    '1. install the SDK: npm install github:julienmessagingme/messagingme-sdk#v{VERSION};',
    '2. with the Messaging Me tools, create the reminder template (UTILITY, the first name then the time, two quick reply',
    '   buttons) and, on the agent that answers, the two actions “Reschedule request” (no field) and “Slot choice” (field slot);',
    '3. write lib/calendar.ts wired to our calendar, jobs/reminders.ts (the day-before job) and the route',
    '   app/api/webhooks/messagingme/route.ts, keeping the same button labels and action names everywhere;',
    '4. subscribe the route to message.received and agent.action, and keep the key and the secret in environment',
    '   variables, never in the code.',
    'Do not invent any route or field: they are in https://api.messagingme.app/openapi.json.',
  ),
];

/** Le prompt de la recette des notifications de commande (`EXEMPLES_CAS.notifications`), qui renvoie vers sa version `.md`. */
export const PROMPT_NOTIFICATIONS: Bilingue = [
  lignes(
    'Branche les notifications de commande WhatsApp dans ce projet, en suivant la recette',
    'https://console.messagingme.app/developers/api/guides/order-notifications.md :',
    '1. installe le SDK : npm install github:julienmessagingme/messagingme-sdk#v{VERSION} ;',
    '2. avec les outils Messaging Me, crée le modèle d’expédition (UTILITY, le prénom puis le numéro de commande, un',
    '   bouton URL vers notre page de suivi) ;',
    '3. écris lib/orders.ts relié à nos commandes (l’envoi quand une commande passe en expédiée) et la route',
    '   app/api/webhooks/messagingme/route.ts qui marque la commande livrée puis lue ;',
    '4. abonne la route à message.delivered et message.read, décochés par défaut, et range la clé et le secret dans',
    '   les variables d’environnement, jamais dans le code.',
    'N’invente aucune route ni aucun champ : ils sont dans https://api.messagingme.app/openapi.json.',
  ),
  lignes(
    'Add WhatsApp order notifications to this project, following the recipe',
    'https://console.messagingme.app/developers/api/guides/order-notifications.en.md:',
    '1. install the SDK: npm install github:julienmessagingme/messagingme-sdk#v{VERSION};',
    '2. with the Messaging Me tools, create the shipping template (UTILITY, the first name then the order number, a',
    '   URL button to our tracking page);',
    '3. write lib/orders.ts wired to our orders (the send when an order moves to shipped) and the route',
    '   app/api/webhooks/messagingme/route.ts that marks the order delivered then read;',
    '4. subscribe the route to message.delivered and message.read, unchecked by default, and keep the key and the',
    '   secret in environment variables, never in the code.',
    'Do not invent any route or field: they are in https://api.messagingme.app/openapi.json.',
  ),
];
