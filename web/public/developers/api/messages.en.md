<!-- Markdown version of https://console.messagingme.app/developers/api/messages, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/messages.md -->

# Messages

One text, to an existing record, sent right away. For a list of recipients, a template or a scenario: [Sends](https://console.messagingme.app/developers/api/sends.en.md).

On this page

|   |   |
| --- | --- |
| POST | [/v1/messages](https://console.messagingme.app/developers/api/messages.en.md#message-meta) : Sends a message in Meta’s format: image, document, location, buttons, list, link button. |
| POST | [/v1/messages/whatsapp](https://console.messagingme.app/developers/api/messages.en.md#message-whatsapp) : Sends a WhatsApp text right away to an existing record. |
| POST | [/v1/messages/rcs](https://console.messagingme.app/developers/api/messages.en.md#message-rcs) : Sends an RCS text right away to an existing record. |

<a id="messages-simples"></a>

## Message or send

|  | Message | Send |
| --- | --- | --- |
| Recipients | One record | 1 to 50 |
| Content | One text | Template, scenario, block or RCS message |
| Processing | Synchronous: the 200 response carries the message | Asynchronous: GET /v1/sends/{sendId} |
| Unknown record | Refused | Created with a phone, except with a whatsapp_session opening |
| Idempotency | No | [Yes, key required](https://console.messagingme.app/developers/api/concepts.en.md#idempotence) |

- The message appears in the Inbox when journal is recorded.
- It takes the thread: the running scenario stops, the Meta agent stops replying.

> **Caution**
>
> No idempotency key: replaying the call sends a second message.

<a id="message-whatsapp"></a>

## POST /v1/messages/whatsapp

Sends a WhatsApp text right away to an existing record.

Scope: `sends:create`

### Request

| Field | Required | Description |
| --- | --- | --- |
| `contactId` : uuid | At least one key | The record id, returned when it is created. [Identifying a person](https://console.messagingme.app/developers/api/concepts.en.md#identification) |
| `externalId` : string | At least one key | Your id for the person, unique per workspace, 512 characters at most. |
| `phone` : string | At least one key | The phone number, in international format (+33…). |
| `bsuid` : string | At least one key | The WhatsApp id of a person with no visible number. |
| `text` : string | Yes | The text, 4096 characters at most. |
| `consent` : string | No | Accepted, no effect: a number linked by QR code never writes first (someone who never wrote is refused, window_closed), and its reply to someone who wrote needs none. Values: `opted_in`. [Consent and STOP](https://console.messagingme.app/developers/api/concepts.en.md#consentement) |
| `consentSource` : string | No | Where the consent comes from, 100 characters at most. Missing: api. |

An unknown key is refused: 400 `invalid_body`.

_Command_

```
curl -X POST https://api.messagingme.app/v1/messages/whatsapp \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "externalId": "crm-7781",
  "text": "Votre commande 8412 est prête, vous pouvez passer la retirer."
}'
```

### 200 response

_JSON_

```
{
  "messageId": "wamid.exemple-8412",
  "conversationId": "c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b",
  "channel": "whatsapp",
  "journal": "recorded"
}
```

In the 200 response, conversationId is always set.

On a number linked by QR code (WhatsApp Business app), a text outside the 24 h window to someone who wrote is queued: the response is 202, status is queued, id is the queued message’s id and scheduledAt its planned departure. The message leaves spaced out and counts in the month’s messages. This number never writes first: to someone who never wrote (no conversation, or no record), the response is 422 window_closed, whatever consent says. The same text to the same number, replayed within the minute, is queued once.

After the provider accepts the message, journal is unrecorded if the Inbox write still fails after one retry. The status remains 200 and messageId identifies the message: do not replay this call.

### Errors

In the order they are checked:

| Status | Code | Cause |
| --- | --- | --- |
| 404 | `unknown_contact` | Unknown record. |
| 409 | `blocked_contact` | Record blocked, or without a WhatsApp address. |
| 422 | `window_closed` | 24-hour window closed; on a number linked by QR code, the person never wrote. |
| 409 | `opted_out` | Record opted out. |
| 409 | `no_whatsapp_number` | Workspace without a WhatsApp number. |
| 409 | `number_unlinked` | Number unlinked from the Home page. |
| 409 | `number_suspended` | Provided number subscription overdue or ended. |
| 422 | `no_phone` | Number linked by QR code: a reply outside the 24 h window to someone with no known number. |
| 402 | `plan_limit_reached` | Number linked by QR code: the month’s messages reached. |
| 400, 409 | `invalid_recipient` `invalid_phone` `identity_conflict` | Record keys missing, unreadable or contradictory: [Identifying a person](https://console.messagingme.app/developers/api/concepts.en.md#identification) |

### Notes

Window closed: only a template can go out (on a number linked by QR code, the reply to someone who wrote is queued). [The 24-hour window](https://console.messagingme.app/developers/api/concepts.en.md#fenetre-24h)

<a id="message-meta"></a>

## POST /v1/messages

Sends a message in Meta’s format: image, document, location, buttons, list, link button.

Scope: `sends:create`

Meta’s body as is, within the 24-hour window: an example from Meta’s documentation (Cloud API, messages) goes through, for the types below and with its media as link. to is the number with its country code, found on its record; contactId or externalId can replace it.

- Types: text, image, video, audio, document, location, reaction, interactive (button, list, cta_url).
- A media goes through a public https URL (link): Meta fetches the file.
- The bounds are Meta’s (3 buttons, 20-character title, 10 list rows); an unknown field is refused as invalid_body, naming the field.
- The contact who taps a button comes back in the message.received event, with its id.

_Command_

```
curl -X POST https://api.messagingme.app/v1/messages \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "messaging_product": "whatsapp",
  "to": "+33612345678",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "body": {
      "text": "Votre commande 8412 part demain. On la livre où ?"
    },
    "action": {
      "buttons": [
        {
          "type": "reply",
          "reply": {
            "id": "domicile",
            "title": "À domicile"
          }
        },
        {
          "type": "reply",
          "reply": {
            "id": "relais",
            "title": "En point relais"
          }
        }
      ]
    }
  }
}'
```

### 200 response

_JSON_

```
{
  "messageId": "wamid.exemple-8412",
  "conversationId": "c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b",
  "channel": "whatsapp",
  "journal": "recorded"
}
```

### Errors

The same as POST /v1/messages/whatsapp, in the same order.

<a id="message-rcs"></a>

## POST /v1/messages/rcs

Sends an RCS text right away to an existing record.

Scope: `sends:create`

### Request

| Field | Required | Description |
| --- | --- | --- |
| `contactId` : uuid | At least one key | The record id, returned when it is created. [Identifying a person](https://console.messagingme.app/developers/api/concepts.en.md#identification) |
| `externalId` : string | At least one key | Your id for the person, unique per workspace, 512 characters at most. |
| `phone` : string | At least one key | The phone number, in international format (+33…). |
| `bsuid` : string | At least one key | The WhatsApp id of a person with no visible number. |
| `text` : string | Yes | The text, 3072 characters at most. |

An unknown key is refused: 400 `invalid_body`.

_Command_

```
curl -X POST https://api.messagingme.app/v1/messages/rcs \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "phone": "+33612345678",
  "text": "Votre rendez-vous de jeudi 14 h est confirmé."
}'
```

### 200 response

That of POST /v1/messages/whatsapp, with channel set to rcs. conversationId is null if the thread cannot be opened after acceptance; journal is then unrecorded. Do not replay the call.

### Errors

In the order they are checked:

| Status | Code | Cause |
| --- | --- | --- |
| 404 | `unknown_contact` | Unknown record. |
| 422 | `no_phone` | Record without a phone number. |
| 409 | `blocked_contact` | Record blocked. |
| 409 | `opted_out` | Opted out, in general or from RCS. |
| 409 | `no_consent` | Neither opted_in, nor ever wrote. |
| 409 | `rcs_not_enabled` | RCS channel inactive on the workspace. |
| 422 | `rcs_unreachable` | Number known as unreachable over RCS. |
| 400, 409 | `invalid_recipient` `invalid_phone` `identity_conflict` | Record keys missing, unreadable or contradictory: [Identifying a person](https://console.messagingme.app/developers/api/concepts.en.md#identification) |

### Notes

- No 24-hour window over RCS.
- RCS reachability is learned afterwards: the first message to a number without RCS is accepted, its failure is recorded (Security > Error log), the next one is refused with `rcs_unreachable`.
