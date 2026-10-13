<!-- Markdown version of https://console.messagingme.app/developers/api/quickstart, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/quickstart.md -->

# Get started in ten minutes

From sign-up to the first message sent through the API, with your own phone to check each step. You need a WhatsApp number (yours, or one we provide) and a server that receives HTTPS requests.

<a id="espace"></a>

## 1. Create your workspace and connect your number

Sign up at `https://console.messagingme.app/signup`. The console chains the steps: connect a WhatsApp number (yours, through Meta’s window, or a provided number), then a page with the two commands that install the Claude Code plugin, your application’s key, and /messagingme:demarrer, which starts the setup.

With no number connected, nothing goes out: [`no_whatsapp_number`](https://console.messagingme.app/developers/api/errors.en.md#no_whatsapp_number).

<a id="cle"></a>

## 2. Create an API key

In the console, Developers > API keys. Tick at least sends:create (send) and conversations:read (read threads). The key (mba_…) is shown only once: keep it server-side, in an environment variable.

_Check the key_

```
curl https://api.messagingme.app/v1/templates \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

A list, even empty, means the key works. Otherwise: [`unauthorized`](https://console.messagingme.app/developers/api/errors.en.md#unauthorized), [`missing_scope`](https://console.messagingme.app/developers/api/errors.en.md#missing_scope).

<a id="webhook"></a>

## 3. Receive events

Declare your server’s address in the console (Developers > Outgoing webhooks), or through the API with a key that carries webhooks:write. The secret (whsec_…) is shown only once: it is used to verify each signature.

_Command_

```
curl -X POST https://api.messagingme.app/v1/webhooks \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "url": "https://www.exemple.fr/messagingme/evenements",
  "description": "Mon application",
  "types": [
    "message.received",
    "template.status_changed"
  ]
}'
```

Verify the signature on the raw body, with the [SDK](https://console.messagingme.app/developers/api/sdk.en.md#webhook) or by hand ([the format](https://console.messagingme.app/developers/api/webhooks.en.md#signature)), then answer 2xx within 10 s.

<a id="premier-envoi"></a>

## 4. A first send

The fastest: from your phone, write to the workspace’s number. Your server receives message.received, with the record created for you. For 24 hours, the API can answer you with a free-form message:

_Command_

```
curl -X POST https://api.messagingme.app/v1/messages/whatsapp \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "phone": "+33612345678",
  "text": "Bien reçu, merci ! Nous revenons vers vous dans la journée."
}'
```

To write first, you need a template approved by Meta: create it in the console (Content > WhatsApp > Templates) or with [POST /v1/templates](https://console.messagingme.app/developers/api/templates.en.md#creer), wait for its approval (from a few minutes to 24 hours), then send it:

_Command_

```
curl -X POST https://api.messagingme.app/v1/sends \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "idempotencyKey": "premier-envoi-1",
  "target": {
    "template": {
      "name": "confirmation_commande",
      "language": "fr"
    }
  },
  "recipients": [
    {
      "phone": "+33612345678"
    }
  ],
  "params": [
    {
      "position": 1,
      "source": {
        "type": "attribute",
        "key": "name"
      },
      "fallback": "Bonjour"
    },
    {
      "position": 2,
      "source": {
        "type": "literal",
        "value": "8412"
      }
    }
  ]
}'
```

- Window closed: [`window_closed`](https://console.messagingme.app/developers/api/errors.en.md#window_closed); use a template.
- No card in Business Manager: [`131042`](https://console.messagingme.app/developers/api/errors.en.md#meta-131042).
- The number is not on WhatsApp: [`131026`](https://console.messagingme.app/developers/api/errors.en.md#meta-131026).

<a id="ensuite"></a>

## Next

- [Meta pitfalls](https://console.messagingme.app/developers/api/guides/meta-pitfalls.en.md): what Meta imposes, before your first bulk send.
- [The Next.js recipe](https://console.messagingme.app/developers/api/guides/nextjs.en.md): the same steps in a project, with a prompt to paste.
- [The error catalog](https://console.messagingme.app/developers/api/errors.en.md): every code and what to do.

> **Note**
>
> With Claude Code, all of this can also be done in conversation: [the MCP server](https://console.messagingme.app/developers/mcp.en.md).
