<!-- Markdown version of https://console.messagingme.app/developers/api/webhooks, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/webhooks.md -->

# Outgoing webhooks

Your app receives what happens on WhatsApp as it happens: each event is POSTed to the address you register, signed and timestamped. Addresses are managed in [Developers > Outgoing webhooks](https://console.messagingme.app/developers/evenements), or from Claude Code with the create_webhook_endpoint MCP tool.

<a id="enveloppe"></a>

## The envelope

The same format for every event: only data changes with type.

_Received body_

```
{
  "id": "evt_5f0c2b9e8d7a4c1b9e3f6a2d4c8b1e07",
  "type": "message.received",
  "created_at": "2026-10-08T14:03:11.000Z",
  "workspace_id": "3f2a9c1e-…",
  "data": {
    "contact": {
      "id": "8b1e07c4-…",
      "phone": "+33612345678",
      "name": "Claire",
      "external_id": null,
      "opted_out": {
        "whatsapp": false,
        "rcs": false
      }
    },
    "channel": "whatsapp",
    "message_id": "wamid.…",
    "message_type": "text",
    "text": "Bonjour, où en est ma commande ?",
    "transcription": null,
    "button": null
  }
}
```

- id is stable: the same on retry and replay. Keep processed ids to ignore a duplicate (delivery is “at least once”).
- No ordering is guaranteed between two events: a read message may arrive before the delivered one.
- The content is frozen when the event happens: a retry sends exactly the same body.

<a id="signature"></a>

## Verifying the signature

The format is Standard Webhooks: three headers, `webhook-id`, `webhook-timestamp`, `webhook-signature`, and an HMAC-SHA256 signature of `id.timestamp.corps` with the key after whsec_ in your secret. Standard Webhooks libraries in every language verify it as is.

_Verification in Node.js_

```
import crypto from 'node:crypto';

// Le corps BRUT reçu (une chaîne), jamais l’objet déjà analysé : la signature porte sur ces octets-là.
export function verifier(corpsBrut, entetes, secret = process.env.MESSAGINGME_WEBHOOK_SECRET) {
  const id = entetes['webhook-id'];
  const horodatage = entetes['webhook-timestamp'];
  // Refuser un envoi de plus de 5 minutes : un rejeu d’un message intercepté ne passe pas.
  if (Math.abs(Date.now() / 1000 - Number(horodatage)) > 300) return false;
  const cle = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const attendue = crypto.createHmac('sha256', cle).update(id + '.' + horodatage + '.' + corpsBrut).digest('base64');
  // Plusieurs signatures pendant une rotation du secret, séparées par une espace : une seule suffit.
  return entetes['webhook-signature'].split(' ').some((s) => {
    const [version, valeur] = s.split(',');
    return version === 'v1' && valeur.length === attendue.length
      && crypto.timingSafeEqual(Buffer.from(valeur), Buffer.from(attendue));
  });
}
```

> **Required**
>
> Store the secret in an environment variable of your app, never in the code nor in a file tracked by git. It is shown only once; a lost secret is rotated (the old one keeps signing for 24 h).

<a id="reessais"></a>

## Response and retries

- Answer 2xx within 10 seconds: the event is delivered. Do long work after answering.
- Any other answer, or none, triggers a retry: 30 s, 2 min, 10 min, 30 min, then hourly, for 24 h.
- 410 Gone stops retrying that event. Redirects are not followed.
- Each delivery is visible in the address log (body sent, response, attempts) and can be replayed in one click.

<a id="types"></a>

## The events

Each address picks its types. Delivery receipts are unchecked by default: a campaign produces up to three per recipient.

| Type | When | data fields |
| --- | --- | --- |
| `message.received` | A contact writes to you (text, tapped button, media, form reply). | contact, channel, message_id, message_type, text, transcription, button |
| `message.delivered` | Meta confirms one of your messages was delivered. (unchecked by default) | contact, channel, message_id, origin, send_id |
| `message.read` | The contact read one of your messages. (unchecked by default) | contact, channel, message_id, origin, send_id |
| `message.failed` | One of your messages could not be delivered. (unchecked by default) | contact, channel, message_id, origin, send_id, reason, meta_code |
| `link.clicked` | The contact clicked a tracked link. | contact, link, template, destination |
| `contact.opted_out` | The contact opted out (STOP, record, bulk action, API). | contact, channel, source |
| `conversation.analyzed` | A conversation analysis is ready (Pro and Enterprise plans). | contact, conversation_id, intent, sentiment, satisfaction, urgency, resolved, topic, action_suggestion, handled_by, exchanges_count, summary |
| `contact.risk_changed` | A contact’s disengagement risk changed level (nightly run). | contact, level, previous_level, score, reasons |
| `template.status_changed` | Meta ruled on one of your templates (approved, rejected, paused, disabled). No contact data. | template, status, reason |
| `conversation.needs_reply` | “My app answers” mode: a message awaits your app’s answer, at the address set as the responder. | contact, conversation_id, channel, message_id, message_type, text, transcription, reply_with |
| `test` | The “Send a test” button, or the send_test_event MCP tool. | message |

The contact carries its id, number (phone), name, external id and opt-outs.

<a id="repondre"></a>

## My app answers

Pick an address in “Who answers the customer” (Home), or with the set_default_responder MCP tool in application mode: each message nobody handles reaches it as `conversation.needs_reply`, with no type to check, ahead of other deliveries. Your app answers through the API, with the workspace API key:

_POST /v1/messages/whatsapp_

```
{
  "contactId": "8b1e07c4-…",
  "text": "Bonjour Claire, votre commande part demain."
}
```

- Answer the webhook 2xx right away, then send the reply: the conversation stays with your app, out of the team’s “To handle” queue.
- The 24-hour window applies: the reply goes out as long as the customer wrote in the last 24 hours.
- Answer conversation.needs_reply only: if the address also receives message.received, the same message arrives twice, and answering both would reply twice. The API key needs the sends:create scope.
- These replies do not count toward the API daily send quota; the per-minute cap applies.
- No fallback: if your app does not answer, nobody does in its place. A paused or deleted address, or one beyond your plan, hands the messages back to the team.
