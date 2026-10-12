<!-- Markdown version of https://console.messagingme.app/developers/api/sdk, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/sdk.md -->

# TypeScript SDK

The TypeScript client of the API: calls typed by path and method, typed errors, and signature verification for outgoing webhooks. Its types are generated from the [OpenAPI contract](https://console.messagingme.app/developers/api.en.md#openapi): a path, body or response that does not exist does not compile.

<a id="installation"></a>

## Installation

_Installation_

```
npm install github:julienmessagingme/messagingme-sdk#v0.1.0
```

- No dependency. Node 20 or later, Deno, Bun, and runtimes that expose fetch and Web Crypto.
- ESM only: import it with import, not require.
- Installing from GitHub needs git on the machine (a minimal Docker image does not always have it).
- A published version never changes: the version follows the tag after the #.

<a id="premier-appel"></a>

## A first call

The API key (`mba_…`) is created in the console, Developers > API keys. Keep it server-side. The client calls the production API; `baseUrl` points to another one.

_TypeScript_

```
import { createClient } from '@messagingme/sdk';

const api = createClient({ apiKey: process.env.MESSAGINGME_API_KEY! });

// Créer une fiche, ou la mettre à jour si elle existe.
const { contactId, status } = await api.POST('/v1/contacts', {
  body: { phone: '+33612345678', name: 'Camille Roy', consent: 'opted_in', consentSource: 'formulaire-site' },
});

// Lire une fiche : les paramètres de chemin passent par path.
const fiche = await api.GET('/v1/contacts/{contactId}', { path: { contactId } });

// Les conversations qui attendent une réponse, par pages : query.
const page = await api.GET('/v1/conversations', { query: { needsReply: true, limit: 20 } });

// Un envoi, rejouable sans doublon avec la même clé d’idempotence. Ici un modèle sans variable :
// avec variables, ajoutez params (voir Envois).
const envoi = await api.POST('/v1/sends', {
  body: {
    target: { template: { name: 'confirmation_commande', language: 'fr' } },
    recipients: [{ phone: '+33612345678' }],
  },
  idempotencyKey: 'commande-7781',
});
```

The scope of each route: [Authentication, limits and errors](https://console.messagingme.app/developers/api/reference.en.md#authentification).

<a id="erreurs"></a>

## Errors

Any non-2xx response throws `ApiError`, with the status, the API code and, when the API says so, the delay to wait. The SDK retries nothing on its own.

_TypeScript_

```
import { ApiError } from '@messagingme/sdk';

try {
  await api.POST('/v1/messages/whatsapp', { body: { contactId, text: 'Bonjour' } });
} catch (e) {
  if (e instanceof ApiError) {
    if (e.code === 'window_closed') { /* la personne n’a pas écrit depuis 24 h : passer par un modèle */ }
    if (e.code === 'meta_rejected') { /* Meta a refusé : son numéro est dans e.body, champ metaCode (131047…) */ }
    if (e.status === 429 && e.retryAfter !== null) { /* attendre e.retryAfter secondes */ }
  }
  throw e;
}
```

- `code` is set on every API error response; it is null when a generic error page replaced the response on the way (a 5xx).
- On meta_rejected, the body (`e.body`) also carries `metaCode`, Meta’s error number: [Meta errors](https://console.messagingme.app/developers/api/errors.en.md#meta).
- `upgradeUrl` is set on a 402 (plan_feature_unavailable, plan_limit_reached): the page where the plan is changed.

<a id="webhook"></a>

## Verifying a webhook

Pass the RAW body, as received: the signature covers its bytes. The format is described in [Outgoing webhooks](https://console.messagingme.app/developers/api/webhooks.en.md#signature).

_TypeScript_

```
import { verifyWebhook, WebhookVerificationError } from '@messagingme/sdk';

// Une route qui reçoit les webhooks sortants (ici avec l’API Request standard).
export async function POST(req: Request) {
  const body = await req.text();
  try {
    const event = await verifyWebhook({ secret: process.env.MESSAGINGME_WEBHOOK_SECRET!, headers: req.headers, body });
    if (event.type === 'message.received') console.log(event.data.text);
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof WebhookVerificationError) return new Response(null, { status: 401 });
    throw e;
  }
}
```

- During a secret rotation, the old one keeps signing for 24 h: pass both, secret: [new, old].
- A timestamp more than 5 minutes away is refused (toleranceSeconds to change it).
- The same event can arrive twice (retry, replay): deduplicate by event.id, equal to the webhook-id header.

> **Required**
>
> An empty or unreadable secret throws a TypeError: it is a configuration error, not a wrong signature. Do not turn it into a 401.
