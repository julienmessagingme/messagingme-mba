<!-- Markdown version of https://console.messagingme.app/developers/api/sends, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/sends.md -->

# Sends

A target (template, scenario, block or RCS message) to 1 to 50 recipients, in the background. Every send shows in Campaigns.

On this page

|   |   |
| --- | --- |
| POST | [/v1/sends](https://console.messagingme.app/developers/api/sends.en.md#envoi) : Starts an asynchronous, idempotent send to 1 to 50 recipients. |
| GET | [/v1/sends/{sendId}](https://console.messagingme.app/developers/api/sends.en.md#suivi) : Reads the state and results of a send. |

<a id="envoi"></a>

## POST /v1/sends

Starts an asynchronous, idempotent send to 1 to 50 recipients.

Scope: `sends:create`

> **Required**
>
> An idempotency key: Idempotency-Key header or idempotencyKey field. [Idempotency](https://console.messagingme.app/developers/api/concepts.en.md#idempotence)

### Request

| Field | Required | Description |
| --- | --- | --- |
| `idempotencyKey` : string | Yes, here or in the Idempotency-Key header | The key that makes the call safe to replay without a double send, 255 characters at most. [Idempotency](https://console.messagingme.app/developers/api/concepts.en.md#idempotence) |
| `target` : object | Yes | What goes out: a template, a scenario, a block or an RCS message. |
| `recipients` : object[] | Yes | From 1 to 50 recipients. |
| `params` : object[] | No | The variables of the template that goes out. |
| `category` : string | Yes, except for a template | Refused on a template: its category is read at Meta. Values: `marketing` , `utility`. |
| `ratePerMinute` : integer | No | From 1 to 80 messages per minute. The channel’s own cap applies afterwards, and may be lower. |
| `phoneNumberId` : string | No | The WhatsApp number that sends. Missing: the workspace’s default number. Ignored for an RCS message. |

An unknown key is refused: 400 `invalid_body`.

_Command: a template, one variable per recipient_

```
curl -X POST https://api.messagingme.app/v1/sends \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "idempotencyKey": "confirmation-8412",
  "target": {
    "template": {
      "name": "confirmation_commande",
      "language": "fr"
    }
  },
  "recipients": [
    {
      "externalId": "crm-7781",
      "phone": "+33612345678",
      "consent": "opted_in",
      "variables": {
        "commande": "8412"
      }
    },
    {
      "contactId": "7a3d9c10-2e4b-4f6a-b8c1-0d9e8f7a6b5c",
      "variables": {
        "commande": "8413"
      }
    }
  ],
  "params": [
    {
      "position": 1,
      "source": {
        "type": "field",
        "key": "prenom"
      }
    },
    {
      "position": 2,
      "source": {
        "type": "variable",
        "key": "commande"
      }
    }
  ],
  "ratePerMinute": 20
}'
```

<a id="cibles"></a>

#### Target types

target carries exactly one key:

| Key | Value | Channel |
| --- | --- | --- |
| `template` | an object: name and language of an approved template (GET /v1/templates) | WhatsApp |
| `scenario` | the scn_ code or the name of a scenario (GET /v1/scenarios) | that of its first send |
| `node` | the nod_ code of a block (Content > Blocks, or entryNode in GET /v1/scenarios) | that of its first send |
| `rcsMessage` | the name of a message in Content > RCS messages (GET /v1/rcs-messages) | RCS, from the workspace’s RCS agent |

<a id="destinataires"></a>

#### Recipients

Each item of recipients:

| Field | Required | Description |
| --- | --- | --- |
| `contactId` : uuid | At least one key | The record id, returned when it is created. [Identifying a person](https://console.messagingme.app/developers/api/concepts.en.md#identification) |
| `externalId` : string | At least one key | Your id for the person, unique per workspace, 512 characters at most. |
| `phone` : string | At least one key | The phone number, in international format (+33…). |
| `bsuid` : string | At least one key | The WhatsApp id of a person with no visible number. |
| `consent` : string | No | Written on the record before filtering. opted_out opts the record out and skips this recipient. Values: `opted_in` , `opted_out`. [Consent and STOP](https://console.messagingme.app/developers/api/concepts.en.md#consentement) |
| `consentSource` : string | No | Where the consent comes from, 100 characters at most. Missing: api. |
| `variables` : object | No | Values specific to this recipient, never written on the record. 50 at most, of 1024 characters at most; names in letters, digits, _, . or -. |

An unknown key is ignored.

- Unknown recipient with a phone: record created, except with a whatsapp_session opening. Otherwise skipped (`unknown_contact`).
- Malformed recipient: skipped (`invalid_recipient`, `invalid_phone`), the send goes on.

<a id="parametres"></a>

#### Parameters and variables

Each item of params:

| Field | Required | Description |
| --- | --- | --- |
| `position` : integer | Yes | The template variable: 1 for {{1}}. Positions 1 to N, with no gap. |
| `source` : object | Yes | Where the value comes from. |
| `fallback` : string | No | The fallback value, when the source is empty. |

An unknown key is ignored.

| source.type | With | Reads |
| --- | --- | --- |
| `field` | `key` | a record field, by its key |
| `attribute` | `key` : `name` , `phone` , `bsuid` , `wa_id` | a record attribute |
| `now` |  | today’s date (DD/MM/YYYY, Paris time) |
| `literal` | `value` | a fixed text |
| `variable` | `key` | a recipient variable (recipients[].variables), on a template only |

Depending on the target:

| Target | params | recipients[].variables |
| --- | --- | --- |
| template | One entry per body variable (GET /v1/templates). Other count: 422 `unsendable_target`. | Read by the variable source. Missing and without fallback: recipient skipped (`missing_variable`). |
| scenario opening with a template | Parameterize that template (openingTemplate), any source except variable. | Refused (400 `invalid_body`). |
| block, scenario opening with RCS | Refused (400 `invalid_body`). A block fills its template with the fields associated with its variables in the console. | Refused (400 `invalid_body`). |
| RCS message | Refused (400 `invalid_body`). | `{{commande}}` : variables.commande, otherwise the record field commande, otherwise empty. |

<a id="ouverture"></a>

#### Opening message

The first message the target sends decides the rules, not the type of the targeted block. The response returns it in opening.

| First send | opening | Rule |
| --- | --- | --- |
| a template | `whatsapp_template` | Goes to someone who has not written. |
| an RCS block | `rcs` | Goes to someone who has not written. Record without a number: skipped (`no_phone`). |
| a quick message, a question, a form, an agent | `whatsapp_session` | 24-hour window required per recipient, otherwise skipped (`window_closed`). |
| a wait before any send, nothing, several possible templates, an unnamed template | (none) | 422 `unsendable_target`, reason in the message. |

- A single branch able to send a session message: the window is required for everyone.
- Scenario with whatsapp_session: refused. Target its entry block (node target, code in entryNode).
- A block accepts all three openings.
- A send plays the published version: a never-published scenario is refused.

<a id="categorie"></a>

#### Category

| Target | category |
| --- | --- |
| template | Refused: read at Meta, marketing or utility. Unreadable or other: 422 `template_category_unknown`. |
| scenario, block, RCS message | Required. First message is a marketing template (scenario, block): marketing, even when declared utility. |

| Category | Recipients skipped |
| --- | --- |
| `marketing` | Every recipient who is not opted_in (`no_consent`). |
| `utility` | Opted-out recipients only. |

### 201 response

_JSON_

```
{
  "sendId": "0b9d7a42-3c1e-4f5a-8d2b-6e7f8a9b0c1d",
  "opening": "whatsapp_template",
  "recipientCount": 1,
  "created": 0,
  "matched": 2,
  "skipped": [
    {
      "index": 1,
      "reason": "opted_out"
    }
  ],
  "skippedTotal": 1
}
```

| Field | Meaning |
| --- | --- |
| `opening` | [Opening message](https://console.messagingme.app/developers/api/sends.en.md#ouverture) |
| `recipientCount` | Recipients kept. |
| `created`, `matched` | Records created, records found. |
| `skipped` | One item per skipped recipient: index in recipients and reason. 200 at most; skippedTotal gives the total. |

Skip reasons: `invalid_recipient` , `invalid_phone` , `unknown_contact` , `duplicate` , `identity_conflict` , `blocked_contact` , `opted_out` , `no_consent` , `window_closed` , `missing_variable` , `no_phone` , `plan_limit_reached`.

### Errors

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | Malformed body, target or params; category missing or not allowed; phoneNumberId unknown to the workspace. |
| 400 | `idempotency_key_required` | Idempotency key missing. |
| 422 | `idempotency_key_reused` | Key already used for another body. |
| 409 | `idempotency_in_progress` | Send in progress with this key. |
| 409 | `no_whatsapp_number` | No WhatsApp number on the workspace (except RCS message). |
| 409 | `number_unlinked` | WhatsApp number unlinked from the Home page, and first message over WhatsApp. Nothing is created. A target opening with RCS goes out. |
| 409 | `number_suspended` | Provided number subscription overdue or ended, and first message over WhatsApp. Nothing is created. |
| 404 | `template_not_found` | Template missing, not approved, or in another language. |
| 422 | `template_category_unknown` | Template category unreadable, or neither marketing nor utility. |
| 404 | `scenario_not_found` | Scenario not found. |
| 409 | `scenario_ambiguous` | Several scenarios have this name: use the scn_ code. |
| 404 | `node_not_found` | Block not found in the published scenarios. |
| 404 | `rcs_message_not_found` | RCS message not found. |
| 409 | `rcs_not_enabled` | RCS channel inactive, rcsMessage target. |
| 422 | `unsendable_target` | The target cannot go out like this; reason in the message. |

### Target examples

_Body: scenario opening with a template (its two params)_

```
{
  "idempotencyKey": "suivi-commande-crm-7781-2026-09-24",
  "target": {
    "scenario": "scn_k3f9qa_01J8Z3M4V6X7Y8Z9A0B1C2D3E4"
  },
  "category": "utility",
  "recipients": [
    {
      "externalId": "crm-7781"
    }
  ],
  "params": [
    {
      "position": 1,
      "source": {
        "type": "field",
        "key": "prenom"
      }
    },
    {
      "position": 2,
      "source": {
        "type": "field",
        "key": "numero_commande"
      }
    }
  ]
}
```

_Body: block, within the window_

```
{
  "idempotencyKey": "relance-fenetre-crm-7781-2026-09-24",
  "target": {
    "node": "nod_k3f9qa_01J8Z3N5W7X8Y9Z0A1B2C3D4E5"
  },
  "category": "utility",
  "recipients": [
    {
      "contactId": "5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01"
    }
  ]
}
```

_Command: RCS message from the library_

```
curl -X POST https://api.messagingme.app/v1/sends \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "idempotencyKey": "rappel-rdv-crm-7781-2026-09-24",
  "target": {
    "rcsMessage": "rappel-rdv"
  },
  "category": "utility",
  "recipients": [
    {
      "externalId": "crm-7781",
      "variables": {
        "date_rdv": "jeudi 25 septembre à 14 h"
      }
    }
  ]
}'
```

<a id="suivi"></a>

## GET /v1/sends/{sendId}

Reads the state and results of a send.

Scope: `sends:create`

### Request

sendId, in the path: the one from the 201 response.

_Command_

```
curl https://api.messagingme.app/v1/sends/0b9d7a42-3c1e-4f5a-8d2b-6e7f8a9b0c1d \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### 200 response

_JSON_

```
{
  "sendId": "0b9d7a42-3c1e-4f5a-8d2b-6e7f8a9b0c1d",
  "status": "running",
  "target": {
    "template": {
      "name": "confirmation_commande",
      "language": "fr"
    }
  },
  "opening": "whatsapp_template",
  "createdAt": "2026-09-24T10:00:00.000Z",
  "counts": {
    "pending": 0,
    "sending": 0,
    "sent": 1,
    "failed": 0,
    "skipped": 0
  },
  "recipientsTotal": 1,
  "recipients": [
    {
      "contactId": "5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01",
      "externalId": "crm-7781",
      "channel": "whatsapp",
      "status": "sent",
      "messageId": "wamid.exemple-8412",
      "delivery": "delivered",
      "error": null,
      "sentAt": "2026-09-24T10:00:04.000Z"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `status` | State of the send, including running, paused and completed. |
| `counts` | Kept recipients, per status. Recipients skipped at creation are not counted here: only in skipped and skippedTotal of the 201 response. |
| `recipients` | One row per kept recipient, 500 at most; recipientsTotal gives the total. |
| `error` | On a failed row: message and metaCode. failed also covers a delivery failure reported after sending. |
| `channel` | Scenario or block: the row describes the start of the journey. channel: its opening channel; messageId and delivery: null. The rest is read in the console. |

### Errors

| Status | Code | Cause |
| --- | --- | --- |
| 404 | `send_not_found` | Unknown send. |
