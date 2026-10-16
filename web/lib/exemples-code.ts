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
export const VERSION_SDK = '0.3.0';

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

/**
 * Le code des cas d'usage (lots 6 et 6 bis), par clé du registre (`web/lib/registre-vitrine.ts`) puis par partie, comme
 * `RECETTE_NEXTJS`. Écrit une fois : le guide l'affiche, la page de la vitrine en montre un extrait
 * (`data-exemple="cas.<clé>.<partie>"`), et `npm run plugin:generer` le recopie dans le dossier de la commande du
 * plugin. `tests/doc-exemples-compiles.test.ts` compile chaque cas dans SON dossier, contre le SDK publié. Commentaires
 * en anglais : ce code se lit aussi sur GitHub.
 */
export const EXEMPLES_CAS = {} as const satisfies Record<string, Record<string, ExempleCode>>;

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
