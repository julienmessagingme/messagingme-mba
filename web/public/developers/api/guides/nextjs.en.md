<!-- Markdown version of https://console.messagingme.app/developers/api/guides/nextjs, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/guides/nextjs.md -->

# Recipe: Next.js

A Next.js project (App Router) that sends a WhatsApp template and receives outgoing webhooks, signature verified. Paste the prompt into your coding assistant, or copy the three files.

<a id="prompt"></a>

## The prompt to paste

In Claude Code, Cursor or another assistant, opened on your project. It points the assistant to this recipe and to the API contract: it has nothing to guess.

_Prompt_

```
Connect Messaging Me (WhatsApp) to this Next.js project (App Router), following the recipe
https://console.messagingme.app/developers/api/guides/nextjs.en.md:
1. install the SDK: npm install github:julienmessagingme/messagingme-sdk#v0.1.0;
2. create lib/messagingme.ts (the client, server-side only);
3. create the POST /api/confirmation route that sends the “confirmation_commande” template (two variables: the
   contact name, then the order number) with an idempotency key taken from the order number, and returns code and
   metaCode (read from the error body) on error;
4. create the POST /api/webhooks/messagingme route that verifies the signature with verifyWebhook on the raw body
   and answers 204;
5. add MESSAGINGME_API_KEY and MESSAGINGME_WEBHOOK_SECRET to .env.local, with no real value in the code.
Do not invent any route or field: they are in https://api.messagingme.app/openapi.json.
```

<a id="installation"></a>

## Installation

_Command_

```
npm install github:julienmessagingme/messagingme-sdk#v0.1.0
```

Two variables in `.env.local`: the API key (Developers > API keys, sends:create scope) and the webhook endpoint secret, shown only once when it is created.

_.env.local_

```
MESSAGINGME_API_KEY=mba_...
MESSAGINGME_WEBHOOK_SECRET=whsec_...
```

<a id="client"></a>

## The client

_lib/messagingme.ts_

```
import { createClient } from '@messagingme/sdk';

// Côté serveur seulement : la clé ne doit jamais partir dans le navigateur (pas de NEXT_PUBLIC_).
export const messagingme = createClient({ apiKey: process.env.MESSAGINGME_API_KEY! });
```

<a id="envoi"></a>

## Sending a template

The template must be approved by Meta ([GET /v1/templates/{name}](https://console.messagingme.app/developers/api/templates.en.md#statut)). The idempotency key taken from the order number prevents a duplicate for 24 hours, even if the route is called again.

_app/api/confirmation/route.ts_

```
import { ApiError } from '@messagingme/sdk';
import { messagingme } from '../../../lib/messagingme';

// POST /api/confirmation, avec phone (au format +33…) et commande dans le corps JSON.
export async function POST(req: Request) {
  const { phone, commande } = (await req.json()) as { phone?: unknown; commande?: unknown };
  if (typeof phone !== 'string' || typeof commande !== 'string') {
    return Response.json({ error: 'phone et commande requis' }, { status: 400 });
  }
  try {
    const envoi = await messagingme.POST('/v1/sends', {
      body: {
        // Le modèle a deux variables : le nom du contact, puis le numéro de commande.
        target: { template: { name: 'confirmation_commande', language: 'fr' } },
        recipients: [{ phone, variables: { commande } }],
        params: [
          { position: 1, source: { type: 'attribute', key: 'name' }, fallback: 'Bonjour' },
          { position: 2, source: { type: 'variable', key: 'commande' } },
        ],
      },
      // Rappelée avec la même commande pendant 24 h, la route ne renvoie pas le message.
      idempotencyKey: `commande-${commande}`,
    });
    return Response.json({ sendId: envoi.sendId, skipped: envoi.skipped });
  } catch (e) {
    if (e instanceof ApiError) {
      // e.code est stable (voir le catalogue des erreurs) ; sur meta_rejected, le corps porte aussi metaCode.
      const metaCode = typeof e.body === 'object' && e.body !== null && 'metaCode' in e.body ? e.body.metaCode : null;
      return Response.json({ code: e.code, metaCode, error: e.message }, { status: e.status });
    }
    throw e;
  }
}
```

- An opted-out recipient or one without consent is not an error: they come back in `skipped`, with the reason.
- An error carries `code` (the catalog: [API codes](https://console.messagingme.app/developers/api/errors.en.md#codes)) and, on [`meta_rejected`](https://console.messagingme.app/developers/api/errors.en.md#meta_rejected), a `metaCode` field in its body (e.body).

<a id="webhook"></a>

## Receiving webhooks

Declare the endpoint `https://votre-domaine/api/webhooks/messagingme` in the console (Developers > Outgoing webhooks) or with [POST /v1/webhooks](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#creer), and tick message.failed: it is unticked by default.

_app/api/webhooks/messagingme/route.ts_

```
import { verifyWebhook, WebhookVerificationError } from '@messagingme/sdk';

export async function POST(req: Request) {
  // Le corps BRUT : la signature porte sur ses octets.
  const body = await req.text();
  let event;
  try {
    event = await verifyWebhook({ secret: process.env.MESSAGINGME_WEBHOOK_SECRET!, headers: req.headers, body });
  } catch (e) {
    if (e instanceof WebhookVerificationError) return new Response(null, { status: 401 });
    throw e;
  }
  // Un même événement peut arriver deux fois : dédoublonnez par event.id.
  if (event.type === 'message.received') console.log('reçu', event.data.contact, event.data.text);
  if (event.type === 'message.failed') console.warn('échec', event.data.meta_code, event.data.reason);
  // Répondre vite (moins de 10 s) : un traitement long se fait après, sinon le webhook est réessayé.
  return new Response(null, { status: 204 });
}
```

> **Required**
>
> Read the RAW body (req.text()), never req.json() before verification: the signature covers the bytes received. Answer within 10 s, otherwise the delivery is retried.

<a id="essayer"></a>

## Trying it

- Send a test event from the console, or with [POST /v1/webhooks/{webhookId}/test](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#essai): the route must answer 204.
- Call POST /api/confirmation with your own number: the template arrives on your phone.
- Reply from your phone: the route receives message.received.
