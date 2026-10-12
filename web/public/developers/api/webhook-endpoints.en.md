<!-- Markdown version of https://console.messagingme.app/developers/api/webhook-endpoints, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/webhook-endpoints.md -->

# Manage outgoing webhooks

The endpoints of your app that receive the events, managed by a key with the webhooks:write scope. They are the same as in Developers > Outgoing webhooks, with the same checks and the same plan limit. The event format: [Outgoing webhooks](https://console.messagingme.app/developers/api/webhooks.en.md).

On this page

|   |   |
| --- | --- |
| GET | [/v1/webhooks](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#lister) : Lists the endpoints, the plan limit and the available types. |
| POST | [/v1/webhooks](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#creer) : Registers an endpoint and returns its secret, only once. |
| GET | [/v1/webhooks/{webhookId}](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#lire) : Reads an endpoint and the state of its deliveries. |
| PATCH | [/v1/webhooks/{webhookId}](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#modifier) : Changes the types, the description, or pauses the endpoint. |
| POST | [/v1/webhooks/{webhookId}/rotate-secret](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#rotation) : Rotates the secret; the old one still signs for 24 h. |
| DELETE | [/v1/webhooks/{webhookId}](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#supprimer) : Deletes an endpoint. |
| POST | [/v1/webhooks/{webhookId}/test](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#essai) : Sends a signed test event and returns the app’s answer. |
| GET | [/v1/webhooks/{webhookId}/deliveries](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#journal) : Reads an endpoint’s log, most recent first. |
| POST | [/v1/webhooks/deliveries/{deliveryId}/replay](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#rejeu) : Replays a finished delivery, with the same body. |
| POST | [/v1/webhooks/{webhookId}/replay-failures](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#rejeu-echecs) : Replays the failed deliveries since a date. |

<a id="lister"></a>

## GET /v1/webhooks

Lists the endpoints, the plan limit and the available types.

Scope: `webhooks:write`

_Command_

```
curl https://api.messagingme.app/v1/webhooks \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### 200 response

_JSON_

```
{
  "data": [
    {
      "id": "3b8e1f2a-7c4d-4e9b-a5f6-0d1c2b3a4e5f",
      "url": "https://www.exemple.fr/messagingme/evenements",
      "description": "Mon application",
      "types": [
        "message.received",
        "template.status_changed"
      ],
      "active": true,
      "createdAt": "2026-10-09T08:00:00.000Z",
      "previousSecretValidUntil": null,
      "lastDeliveredAt": "2026-10-09T09:41:02.000Z",
      "retrying": 0,
      "failed": 1
    }
  ],
  "limit": 5,
  "types": [
    "message.received",
    "template.status_changed"
  ],
  "defaultTypes": [
    "message.received",
    "template.status_changed"
  ]
}
```

limit: the plan’s active endpoints, null without a limit. The secret is never read back.

<a id="creer"></a>

## POST /v1/webhooks

Registers an endpoint and returns its secret, only once.

Scope: `webhooks:write`

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

### 201 response

_JSON_

```
{
  "webhook": {
    "id": "3b8e1f2a-7c4d-4e9b-a5f6-0d1c2b3a4e5f",
    "url": "https://www.exemple.fr/messagingme/evenements",
    "description": "Mon application",
    "types": [
      "message.received",
      "template.status_changed"
    ],
    "active": true,
    "createdAt": "2026-10-09T08:00:00.000Z",
    "previousSecretValidUntil": null,
    "lastDeliveredAt": "2026-10-09T09:41:02.000Z",
    "retrying": 0,
    "failed": 1
  },
  "secret": "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
}
```

> **Caution**
>
> The secret is only shown here: store it in an environment variable of your app.

- url: https, reachable from the Internet. It cannot be changed later: delete and recreate.
- types: absent, all except the three delivery receipts.

### Errors

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | Body outside the format, or address refused (http, internal host). |
| 402 | `plan_limit_reached` | The plan’s active endpoint limit is reached. |

<a id="lire"></a>

## GET /v1/webhooks/{webhookId}

Reads an endpoint and the state of its deliveries.

Scope: `webhooks:write`

### 200 response

_JSON_

```
{
  "id": "3b8e1f2a-7c4d-4e9b-a5f6-0d1c2b3a4e5f",
  "url": "https://www.exemple.fr/messagingme/evenements",
  "description": "Mon application",
  "types": [
    "message.received",
    "template.status_changed"
  ],
  "active": true,
  "createdAt": "2026-10-09T08:00:00.000Z",
  "previousSecretValidUntil": null,
  "lastDeliveredAt": "2026-10-09T09:41:02.000Z",
  "retrying": 0,
  "failed": 1
}
```

| Status | Code | Cause |
| --- | --- | --- |
| 404 | `webhook_not_found` | Endpoint unknown to this workspace. |

<a id="modifier"></a>

## PATCH /v1/webhooks/{webhookId}

Changes the types, the description, or pauses the endpoint.

Scope: `webhooks:write`

active false pauses the endpoint; true turns it back on, within the plan limit.

_Body_

```
{
  "active": false
}
```

### Response

The endpoint, as GET /v1/webhooks/{webhookId}.

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | Body outside the format. |
| 404 | `webhook_not_found` | Endpoint unknown to this workspace. |
| 402 | `plan_limit_reached` | Reactivation beyond the plan limit. |

<a id="rotation"></a>

## POST /v1/webhooks/{webhookId}/rotate-secret

Rotates the secret; the old one still signs for 24 h.

Scope: `webhooks:write`

Returns { secret, previousSecretValidUntil }: the old secret still signs for 24 h, while you update the app.

| Status | Code | Cause |
| --- | --- | --- |
| 404 | `webhook_not_found` | Endpoint unknown to this workspace. |

<a id="supprimer"></a>

## DELETE /v1/webhooks/{webhookId}

Deletes an endpoint.

Scope: `webhooks:write`

204 without a body. The endpoint’s pending deliveries stop.

| Status | Code | Cause |
| --- | --- | --- |
| 404 | `webhook_not_found` | Endpoint unknown to this workspace. |

<a id="essai"></a>

## POST /v1/webhooks/{webhookId}/test

Sends a signed test event and returns the app’s answer.

Scope: `webhooks:write`

Sends a signed test event right away, even to a paused endpoint, and returns { eventId, delivered, statusCode, response }.

| Status | Code | Cause |
| --- | --- | --- |
| 404 | `webhook_not_found` | Endpoint unknown to this workspace. |

<a id="journal"></a>

## GET /v1/webhooks/{webhookId}/deliveries

Reads an endpoint’s log, most recent first.

Scope: `webhooks:write`

_Command_

```
curl https://api.messagingme.app/v1/webhooks/{webhookId}/deliveries?limit=20 \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### 200 response

_JSON_

```
{
  "data": [
    {
      "id": "9c2e4a10-6b3d-4f7a-8e1c-2d5b7a9f0c3e",
      "eventId": "evt_4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c",
      "type": "message.received",
      "status": "failed",
      "attempts": 9,
      "lastStatusCode": 500,
      "lastResponse": "erreur interne",
      "nextAttemptAt": null,
      "createdAt": "2026-10-09T08:12:30.000Z",
      "deliveredAt": null,
      "body": "{\"id\":\"evt_4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c\",\"type\":\"message.received\",\"created_at\":\"2026-10-09T08:12:30.000Z\",\"workspace_id\":\"…\",\"data\":{}}"
    }
  ],
  "nextBefore": null
}
```

- limit: 1 to 100, 50 by default. before: an ISO date, the one nextBefore returns for the next page.
- status: pending (in progress or retrying), delivered, failed. body: the body sent, byte for byte; it carries contact data.

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | limit or before outside the format. |
| 404 | `webhook_not_found` | Endpoint unknown to this workspace. |

<a id="rejeu"></a>

## POST /v1/webhooks/deliveries/{deliveryId}/replay

Replays a finished delivery, with the same body.

Scope: `webhooks:write`

202 { replayed: true }: the delivery goes again with the same body and the same event id (your app deduplicates).

| Status | Code | Cause |
| --- | --- | --- |
| 404 | `delivery_not_found` | Identifier that is not a delivery id. |
| 409 | `delivery_not_replayable` | Delivery unknown to this workspace, still pending, or a test: nothing to replay. |

<a id="rejeu-echecs"></a>

## POST /v1/webhooks/{webhookId}/replay-failures

Replays the failed deliveries since a date.

Scope: `webhooks:write`

_Command_

```
curl -X POST https://api.messagingme.app/v1/webhooks/{webhookId}/replay-failures \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "since": "2026-10-09T00:00:00Z"
}'
```

202 { replayed }: the number of failed deliveries replayed since since, 500 at most per call.

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | since missing or outside the format. |
| 404 | `webhook_not_found` | Endpoint unknown to this workspace. |
