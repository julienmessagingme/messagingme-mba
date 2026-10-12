<!-- Markdown version of https://console.messagingme.app/developers/api/contacts, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/contacts.md -->

# Contacts

A record is designated by its keys: [Identifying a person](https://console.messagingme.app/developers/api/concepts.en.md#identification).

On this page

|   |   |
| --- | --- |
| POST | [/v1/contacts](https://console.messagingme.app/developers/api/contacts.en.md#creer) : Creates or updates a record. |
| POST | [/v1/contacts/batch](https://console.messagingme.app/developers/api/contacts.en.md#lot) : Creates or updates up to 50 records in one call. |
| GET | [/v1/contacts/{contactId}](https://console.messagingme.app/developers/api/contacts.en.md#lire) : Reads a record. |
| POST | [/v1/contacts/search](https://console.messagingme.app/developers/api/contacts.en.md#rechercher) : Finds a record by phone, BSUID or external id. |
| DELETE | [/v1/contacts/{contactId}](https://console.messagingme.app/developers/api/contacts.en.md#effacer) : Erases a record for good (GDPR), within the plan’s daily limit. |
| GET | [/v1/fields](https://console.messagingme.app/developers/api/contacts.en.md#champs) : Lists the custom fields: the keys to use in fields. |
| POST | [/v1/fields](https://console.messagingme.app/developers/api/contacts.en.md#creer-champ) : Creates a custom field; its key comes from the label. |
| PATCH | [/v1/contacts/{contactId}](https://console.messagingme.app/developers/api/contacts.en.md#modifier) : Updates a record’s fields, tags, consent or external id. |

<a id="creer"></a>

## POST /v1/contacts

Creates or updates a record.

Scope: `contacts:write`

### Request

| Field | Required | Description |
| --- | --- | --- |
| `contactId` : uuid | At least one key | The record id, returned when it is created. [Identifying a person](https://console.messagingme.app/developers/api/concepts.en.md#identification) |
| `externalId` : string | At least one key | Your id for the person, unique per workspace, 512 characters at most. |
| `phone` : string | At least one key | The phone number, in international format (+33…). |
| `bsuid` : string | At least one key | The WhatsApp id of a person with no visible number. |
| `name` : string | No | The display name. |
| `fields` : object | No | The record fields, by technical key or fld_ code, 20 at most. Text, number or boolean value, stored as text. A field unknown to the workspace is refused: create it first in the console (Library > Fields). |
| `tags` : string[] | No | Tags to add, 20 at most. None is removed: PATCH does that. A tag unknown to the workspace is refused: declare it first in the console (Library > Tags). |
| `consent` : string | No | Missing: unchanged. Values: `opted_in` , `opted_out`. [Consent and STOP](https://console.messagingme.app/developers/api/concepts.en.md#consentement) |
| `consentSource` : string | No | Where the consent comes from, 100 characters at most. Missing: api. |

An unknown key is ignored. Refused: `optIn` , `optInSource` (the former names of consent and consentSource).

_Command_

```
curl -X POST https://api.messagingme.app/v1/contacts \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "phone": "+33612345678",
  "externalId": "crm-7781",
  "name": "Camille Roy",
  "fields": {
    "ville": "Lyon"
  },
  "tags": [
    "prospect"
  ],
  "consent": "opted_in",
  "consentSource": "formulaire-site"
}'
```

### 200 response

_JSON_

```
{
  "contactId": "5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01",
  "status": "created"
}
```

status: created or updated. The HTTP status is 200 in both cases.

### Errors

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | Malformed or refused field, too many fields or tags, field or tag unknown to the workspace; the message names it. |
| 404 | `unknown_contact` | No record found, and neither phone nor bsuid to create one (an externalId alone, for instance). |
| 409 | `opted_out` | consent opted_in on an opted-out record. Nothing is changed. |
| 400, 409 | `invalid_recipient` `invalid_phone` `identity_conflict` | Record keys missing, unreadable or contradictory: [Identifying a person](https://console.messagingme.app/developers/api/concepts.en.md#identification) |

<a id="lot"></a>

## POST /v1/contacts/batch

Creates or updates up to 50 records in one call.

Scope: `contacts:write`

### Request

| Field | Required | Description |
| --- | --- | --- |
| `contacts` : object[] | Yes | From 1 to 50 records, each with the fields of POST /v1/contacts, but 10 fields and 10 tags at most per record. |

An unknown key is ignored.

_Command_

```
curl -X POST https://api.messagingme.app/v1/contacts/batch \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "contacts": [
    {
      "phone": "+33612345678",
      "externalId": "crm-7781"
    },
    {
      "phone": "+33698765432",
      "externalId": "crm-7782",
      "consent": "opted_out",
      "consentSource": "desinscription-email"
    }
  ]
}'
```

### 200 response

_JSON_

```
{
  "results": [
    {
      "index": 0,
      "status": "updated",
      "contactId": "5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01"
    },
    {
      "index": 1,
      "status": "created",
      "contactId": "7a3d9c10-2e4b-4f6a-b8c1-0d9e8f7a6b5c"
    }
  ],
  "created": 1,
  "updated": 1,
  "errors": 0
}
```

| Field | Meaning |
| --- | --- |
| `results` | One result per item, in order: index, status (created, updated or error), and for a refusal code and reason. |
| `created`, `updated`, `errors` | The number of results with each status. |

### Errors

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | contacts missing, empty, or too long. |

### Notes

- A refused item (malformed, too many fields or tags, unknown field or tag) does not stop the others.
- Items that designate the same person are written in the order of the list.
- Importing a file: send it in batches of 50, as below (a module: .mjs file). At the default limits, 3000 records per minute, 50000 per hour and 20000 per day. A 429 wrote nothing: wait for Retry-After (until midnight for the daily quota) and send the same records again. A very large file goes faster through the console’s CSV import.

_Importing a simple CSV (phone,name), Node.js_

```
import { readFileSync } from 'node:fs';

const lignes = readFileSync('contacts.csv', 'utf8').trim().split(/\r?\n/).slice(1);
const fiches = lignes.map((l) => { const [phone, name] = l.split(','); return { phone, name }; });

for (let i = 0; i < fiches.length; ) {
  const r = await fetch('https://api.messagingme.app/v1/contacts/batch', {
    method: 'POST',
    headers: { authorization: 'Bearer mba_xxxxxxxxxxxxxxxx', 'content-type': 'application/json' },
    body: JSON.stringify({ contacts: fiches.slice(i, i + 50) }),
  });
  if (r.status === 429) {
    await new Promise((ok) => setTimeout(ok, Number(r.headers.get('retry-after') ?? 2) * 1000));
    continue;
  }
  if (!r.ok) throw new Error(await r.text());
  const { results } = await r.json();
  for (const e of results.filter((x) => x.status === 'error')) console.log(i + e.index, e.code, e.reason);
  i += 50;
}
```

<a id="lire"></a>

## GET /v1/contacts/{contactId}

Reads a record.

Scope: `contacts:read`

### Request

contactId, in the path.

_Command_

```
curl https://api.messagingme.app/v1/contacts/5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01 \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### 200 response

_JSON_

```
{
  "contactId": "5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01",
  "externalId": "crm-7781",
  "phone": "+33612345678",
  "bsuid": null,
  "name": "Camille Roy",
  "fields": {
    "ville": "Lyon"
  },
  "tags": [
    "prospect"
  ],
  "consent": {
    "status": "opted_in",
    "source": "formulaire-site",
    "optedOutAt": null
  },
  "rcsOptedOutAt": null,
  "blocked": false,
  "reachability": {
    "whatsapp": true,
    "rcs": null
  },
  "engagementRisk": {
    "level": "moyen",
    "score": 40,
    "reasons": [
      "silence_60j"
    ],
    "computedAt": "2026-09-25T03:05:00.000Z"
  },
  "lastAnalysis": {
    "intent": "suivi_commande",
    "sentiment": "negatif",
    "satisfaction": 3,
    "urgency": 7,
    "resolved": false,
    "topic": "Colis en retard",
    "handledBy": "humain",
    "actionSuggestion": "rappeler",
    "analyzedAt": "2026-09-26T14:32:00.000Z"
  },
  "createdAt": "2026-09-24T10:00:00.000Z"
}
```

| Field | Meaning |
| --- | --- |
| `consent` | status: opted_in, opted_out or unknown. source: its origin. optedOutAt: opt-out date. |
| `rcsOptedOutAt` | Date of a STOP on the RCS channel, otherwise null. |
| `blocked` | true: a message to the record is refused, a send skips it. |
| `reachability` | true or false when a send has learned it, null otherwise. |

`engagementRisk`: disengagement risk, recomputed every night over the last 90 days (replies, clicks, reads, last analysed conversation, reachability, unsubscribe, block). null if never computed. level: `faible` (score 0 to 29), `moyen` (30 to 59), `eleve` (60 to 100), `inconnu` (score null: no message delivered over the period). Unsubscribe or block: eleve, score 100. reasons: at most 3 codes, heaviest first, among `stop`, `bloque`, `silence_60j`, `silence_30j`, `sans_reponse`, `non_lu`, `reclamation`, `negatif`, `insatisfait`, `injoignable`. computedAt: when the contact reached this level; it only changes with the level, while score and reasons are always current.

`lastAnalysis`: the contact’s latest conversation analysis, copied onto the record; it stays when the conversation is deleted. null if never analysed. Read-only: ignored when sent in a POST or a PATCH. intent: `demande_devis`, `sav`, `reclamation`, `information`, `prise_rdv`, `achat`, `suivi_commande`, `retour`, `autre`. sentiment: `positif`, `neutre`, `negatif`. satisfaction and urgency: from 0 to 10, null when the analysis could not measure them (0 is a real measure). resolved: whether the conversation is resolved. topic: its subject, in plain words. handledBy: `humain`, `automatise`, `mba`. actionSuggestion: `creer_devis`, `rappeler`, `relancer`, `escalader`, `aucune`. analyzedAt: when the analysis ran. The conversation summary is not included: it quotes what the customer said.

### Errors

| Status | Code | Cause |
| --- | --- | --- |
| 404 | `unknown_contact` | Unknown or deleted record. |

<a id="rechercher"></a>

## POST /v1/contacts/search

Finds a record by phone, BSUID or external id.

Scope: `contacts:read`

### Request

| Field | Required | Description |
| --- | --- | --- |
| `externalId` : string | Exactly one | Your id for the person, unique per workspace, 512 characters at most. |
| `phone` : string | Exactly one | The phone number, in international format (+33…). |
| `bsuid` : string | Exactly one | The WhatsApp id of a person with no visible number. |

An unknown key is ignored.

_Command_

```
curl -X POST https://api.messagingme.app/v1/contacts/search \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "externalId": "crm-7781"
}'
```

### 200 response

_JSON_

```
{
  "contact": {
    "contactId": "5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01",
    "externalId": "crm-7781",
    "phone": "+33612345678",
    "bsuid": null,
    "name": "Camille Roy",
    "fields": {
      "ville": "Lyon"
    },
    "tags": [
      "prospect"
    ],
    "consent": {
      "status": "opted_in",
      "source": "formulaire-site",
      "optedOutAt": null
    },
    "rcsOptedOutAt": null,
    "blocked": false,
    "reachability": {
      "whatsapp": true,
      "rcs": null
    },
    "engagementRisk": {
      "level": "moyen",
      "score": 40,
      "reasons": [
        "silence_60j"
      ],
      "computedAt": "2026-09-25T03:05:00.000Z"
    },
    "lastAnalysis": {
      "intent": "suivi_commande",
      "sentiment": "negatif",
      "satisfaction": 3,
      "urgency": 7,
      "resolved": false,
      "topic": "Colis en retard",
      "handledBy": "humain",
      "actionSuggestion": "rappeler",
      "analyzedAt": "2026-09-26T14:32:00.000Z"
    },
    "createdAt": "2026-09-24T10:00:00.000Z"
  }
}
```

contact: the record, in the shape of GET /v1/contacts/{contactId}, or null. Nothing is created or attached.

### Errors

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | No key, or several. |
| 400 | `invalid_phone` | Unreadable phone number. |

<a id="modifier"></a>

## PATCH /v1/contacts/{contactId}

Updates a record’s fields, tags, consent or external id.

Scope: `contacts:write`

### Request

contactId, in the path. Body: at least one field.

| Field | Required | Description |
| --- | --- | --- |
| `name` : string | No | The new name. null clears it. |
| `fields` : object | No | Merged with the record fields, 20 at most. A null value clears the field. A field unknown to the workspace is refused. |
| `addTags` : string[] | No | Tags to add, 20 at most. A tag unknown to the workspace is refused. |
| `removeTags` : string[] | No | Tags to remove, 20 at most. |
| `consent` : string | No | Missing: unchanged. Values: `opted_in` , `opted_out`. [Consent and STOP](https://console.messagingme.app/developers/api/concepts.en.md#consentement) |
| `consentSource` : string | No | Where the consent comes from, 100 characters at most. Missing: api. |
| `externalId` : string | No | Sets or replaces your id, 512 characters at most. |

An unknown key is ignored. Refused: `phone` , `bsuid` (they carry the record’s conversations).

_Command_

```
curl -X PATCH https://api.messagingme.app/v1/contacts/5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01 \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "fields": {
    "ville": "Grenoble",
    "code_promo": null
  },
  "addTags": [
    "client"
  ],
  "removeTags": [
    "prospect"
  ],
  "consent": "opted_out",
  "consentSource": "centre-de-preferences"
}'
```

### 200 response

_JSON_

```
{
  "contactId": "5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01"
}
```

### Errors

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | Nothing to change, too many fields or tags, field or tag to add unknown to the workspace, or refused value. |
| 404 | `unknown_contact` | Unknown record. |
| 409 | `identity_conflict` | externalId already carried by another record. |
| 409 | `opted_out` | consent opted_in on an opted-out record. |

<a id="effacer"></a>

## DELETE /v1/contacts/{contactId}

Erases a record for good (GDPR), within the plan’s daily limit.

Scope: `contacts:admin`

With the contacts:admin scope. Irreversible: the record, its conversations, messages and analysis are erased; what carries the counters is anonymised. Within the plan’s daily limit (10 on Free, unlimited on Pro and Enterprise). An opted-out record (STOP) leaves a fingerprint of its number, unreadable without our key, kept three years after the STOP: recreated, it is born opted out.

### 200 response

_JSON_

```
{
  "deleted": true,
  "conversations": 1,
  "messages": 14
}
```

### Errors

| Status | Code | Cause |
| --- | --- | --- |
| 404 | `unknown_contact` | Record unknown to this workspace, or already erased (the daily limit is not used). |
| 402 | `plan_limit_reached` | The plan’s daily erase limit is reached. |
| 429 | `rate_limited` | Too many heavy operations on this workspace (10 per minute, like the console purge): retry after Retry-After. |

<a id="champs"></a>

## GET /v1/fields

Lists the custom fields: the keys to use in fields.

Scope: `contacts:read`

_Command_

```
curl https://api.messagingme.app/v1/fields \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### 200 response

_JSON_

```
{
  "data": [
    {
      "key": "numero_commande",
      "label": "Numéro de commande",
      "type": "text"
    },
    {
      "key": "date_de_naissance",
      "label": "Date de naissance",
      "type": "date"
    }
  ]
}
```

key is the key to use in a record’s fields; type: text, number, date, datetime, boolean or url.

<a id="creer-champ"></a>

## POST /v1/fields

Creates a custom field; its key comes from the label.

Scope: `contacts:admin`

_Command_

```
curl -X POST https://api.messagingme.app/v1/fields \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "label": "Date de naissance",
  "type": "date"
}'
```

### 201 response

_JSON_

```
{
  "key": "date_de_naissance",
  "label": "Date de naissance",
  "type": "date"
}
```

The key comes from the label (lowercase, no accents, _ between words) and never changes. Renaming or deleting a field is done in the console.

### Errors

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | Empty or too long label (100), unknown type. |
| 409 | `field_exists` | A field already has this key, or it is a base field’s label (Name, Phone…). |
