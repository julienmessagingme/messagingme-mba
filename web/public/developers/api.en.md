<!-- Markdown version of https://console.messagingme.app/developers/api, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api.md -->

# Messaging Me API

REST API: contacts, WhatsApp and RCS messages, sends.

<a id="premier-appel"></a>

## First call

Create a record, or update it if it exists:

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

_200 response_

```
{
  "contactId": "5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01",
  "status": "created"
}
```

Details: [POST /v1/contacts](https://console.messagingme.app/developers/api/contacts.en.md#creer).

<a id="endpoints"></a>

## All endpoints

### Contacts

|   |   |   |
| --- | --- | --- |
| POST | [/v1/contacts](https://console.messagingme.app/developers/api/contacts.en.md#creer) : Creates or updates a record. | `contacts:write` |
| POST | [/v1/contacts/batch](https://console.messagingme.app/developers/api/contacts.en.md#lot) : Creates or updates up to 50 records in one call. | `contacts:write` |
| GET | [/v1/contacts/{contactId}](https://console.messagingme.app/developers/api/contacts.en.md#lire) : Reads a record. | `contacts:read` |
| POST | [/v1/contacts/search](https://console.messagingme.app/developers/api/contacts.en.md#rechercher) : Finds a record by phone, BSUID or external id. | `contacts:read` |
| DELETE | [/v1/contacts/{contactId}](https://console.messagingme.app/developers/api/contacts.en.md#effacer) : Erases a record for good (GDPR), within the plan’s daily limit. | `contacts:admin` |
| GET | [/v1/fields](https://console.messagingme.app/developers/api/contacts.en.md#champs) : Lists the custom fields: the keys to use in fields. | `contacts:read` |
| POST | [/v1/fields](https://console.messagingme.app/developers/api/contacts.en.md#creer-champ) : Creates a custom field; its key comes from the label. | `contacts:admin` |
| PATCH | [/v1/contacts/{contactId}](https://console.messagingme.app/developers/api/contacts.en.md#modifier) : Updates a record’s fields, tags, consent or external id. | `contacts:write` |

### Messages

|   |   |   |
| --- | --- | --- |
| POST | [/v1/messages](https://console.messagingme.app/developers/api/messages.en.md#message-meta) : Sends a message in Meta’s format: image, document, location, buttons, list, link button. | `sends:create` |
| POST | [/v1/messages/whatsapp](https://console.messagingme.app/developers/api/messages.en.md#message-whatsapp) : Sends a WhatsApp text right away to an existing record. | `sends:create` |
| POST | [/v1/messages/rcs](https://console.messagingme.app/developers/api/messages.en.md#message-rcs) : Sends an RCS text right away to an existing record. | `sends:create` |

### Conversations

|   |   |   |
| --- | --- | --- |
| GET | [/v1/conversations](https://console.messagingme.app/developers/api/conversations.en.md#lister) : Lists conversations, most recent first, page by page. | `conversations:read` |
| GET | [/v1/conversations/{conversationId}](https://console.messagingme.app/developers/api/conversations.en.md#lire) : Reads a conversation: the contact, who handles it, the 24-hour window. | `conversations:read` |
| GET | [/v1/conversations/{conversationId}/messages](https://console.messagingme.app/developers/api/conversations.en.md#messages) : A conversation’s messages, most recent first, page by page. | `conversations:read` |
| GET | [/v1/messages/{messageId}](https://console.messagingme.app/developers/api/conversations.en.md#message) : Reads a message by its ID. | `conversations:read` |
| GET | [/v1/messages/{messageId}/media](https://console.messagingme.app/developers/api/conversations.en.md#media) : Downloads the file of a received message. | `conversations:read` |

### Sends

|   |   |   |
| --- | --- | --- |
| POST | [/v1/sends](https://console.messagingme.app/developers/api/sends.en.md#envoi) : Starts an asynchronous, idempotent send to 1 to 50 recipients. | `sends:create` |
| GET | [/v1/sends/{sendId}](https://console.messagingme.app/developers/api/sends.en.md#suivi) : Reads the state and results of a send. | `sends:create` |

### Templates

|   |   |   |
| --- | --- | --- |
| POST | [/v1/templates](https://console.messagingme.app/developers/api/templates.en.md#creer) : Creates a template in Meta’s format and submits it for review. | `templates:write` |
| GET | [/v1/templates/{name}](https://console.messagingme.app/developers/api/templates.en.md#statut) : Reads a template’s status at Meta, language by language. | `templates:write` |

### Outgoing webhooks

|   |   |   |
| --- | --- | --- |
| GET | [/v1/webhooks](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#lister) : Lists the endpoints, the plan limit and the available types. | `webhooks:write` |
| POST | [/v1/webhooks](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#creer) : Registers an endpoint and returns its secret, only once. | `webhooks:write` |
| GET | [/v1/webhooks/{webhookId}](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#lire) : Reads an endpoint and the state of its deliveries. | `webhooks:write` |
| PATCH | [/v1/webhooks/{webhookId}](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#modifier) : Changes the types, the description, or pauses the endpoint. | `webhooks:write` |
| POST | [/v1/webhooks/{webhookId}/rotate-secret](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#rotation) : Rotates the secret; the old one still signs for 24 h. | `webhooks:write` |
| DELETE | [/v1/webhooks/{webhookId}](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#supprimer) : Deletes an endpoint. | `webhooks:write` |
| POST | [/v1/webhooks/{webhookId}/test](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#essai) : Sends a signed test event and returns the app’s answer. | `webhooks:write` |
| GET | [/v1/webhooks/{webhookId}/deliveries](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#journal) : Reads an endpoint’s log, most recent first. | `webhooks:write` |
| POST | [/v1/webhooks/deliveries/{deliveryId}/replay](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#rejeu) : Replays a finished delivery, with the same body. | `webhooks:write` |
| POST | [/v1/webhooks/{webhookId}/replay-failures](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#rejeu-echecs) : Replays the failed deliveries since a date. | `webhooks:write` |

### Catalogs

|   |   |   |
| --- | --- | --- |
| GET | [/v1/templates](https://console.messagingme.app/developers/api/catalogs.en.md#templates) : Lists the approved, sendable WhatsApp templates. | `sends:create` |
| GET | [/v1/scenarios](https://console.messagingme.app/developers/api/catalogs.en.md#scenarios) : Lists the published scenarios and their opening message. | `sends:create` |
| GET | [/v1/rcs-messages](https://console.messagingme.app/developers/api/catalogs.en.md#messages-rcs) : Lists the RCS messages of the library. | `sends:create` |

<a id="adresse"></a>

## Base URL

_Base URL_

```
https://api.messagingme.app/v1
```

<a id="openapi"></a>

## OpenAPI contract

The OpenAPI 3.1 contract of the API, served by the API itself and therefore always equal to the code in production: every route, its scope, its body, its response, its errors, and the outgoing webhook events. Import it into a request tool or a client generator.

_Contract_

```
https://api.messagingme.app/openapi.json
```

[Open the contract](https://api.messagingme.app/openapi.json)

In TypeScript, the client generated from this contract: [TypeScript SDK](https://console.messagingme.app/developers/api/sdk.en.md).

<a id="authentification"></a>

## Authentication

An API key in the Authorization header of every call:

_Header_

```
Authorization: Bearer mba_xxxxxxxxxxxxxxxx
```

Keys are created in the console (Developers > API keys), with an admin account.

Scopes, rate limit and errors: [Authentication, limits and errors](https://console.messagingme.app/developers/api/reference.en.md).
