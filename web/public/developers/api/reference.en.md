<!-- Markdown version of https://console.messagingme.app/developers/api/reference, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/reference.md -->

# Authentication, limits and errors

Applies to every route.

<a id="authentification"></a>

## Authentication and scopes

- One key per call, in the Authorization header. It starts with mba_.
- The workspace is derived from the key: no URL carries a workspace id.
- Base URL: [Overview](https://console.messagingme.app/developers/api.en.md#adresse).
- Each route’s scope, errors and shapes, machine-readable: [the OpenAPI contract](https://console.messagingme.app/developers/api.en.md#openapi).

_Header_

```
Authorization: Bearer mba_xxxxxxxxxxxxxxxx
```

| Scope | Opens | Routes |
| --- | --- | --- |
| `contacts:write` | Create and update records. | POST /v1/contacts POST /v1/contacts/batch PATCH /v1/contacts/{contactId} |
| `contacts:read` | Read and find records. | GET /v1/contacts/{contactId} POST /v1/contacts/search GET /v1/fields |
| `sends:create` | Send, follow a send, read the catalogs. | POST /v1/messages POST /v1/messages/whatsapp POST /v1/messages/rcs POST /v1/sends GET /v1/sends/{sendId} GET /v1/templates GET /v1/scenarios GET /v1/rcs-messages |
| `conversations:read` | Read conversations, their messages and received files. | GET /v1/conversations GET /v1/conversations/{conversationId} GET /v1/conversations/{conversationId}/messages GET /v1/messages/{messageId} GET /v1/messages/{messageId}/media |
| `templates:write` | Create templates and follow their review by Meta. | POST /v1/templates GET /v1/templates/{name} |
| `contacts:admin` | Create custom fields and erase a record for good (GDPR). | DELETE /v1/contacts/{contactId} POST /v1/fields |
| `webhooks:write` | Manage outgoing webhooks, read and replay their log (it carries contact data). | GET /v1/webhooks POST /v1/webhooks GET /v1/webhooks/{webhookId} PATCH /v1/webhooks/{webhookId} POST /v1/webhooks/{webhookId}/rotate-secret DELETE /v1/webhooks/{webhookId} POST /v1/webhooks/{webhookId}/test GET /v1/webhooks/{webhookId}/deliveries POST /v1/webhooks/deliveries/{deliveryId}/replay POST /v1/webhooks/{webhookId}/replay-failures |

| Status | Code | Cause |
| --- | --- | --- |
| 401 | `unauthorized` | Key missing, malformed, unknown or revoked. |
| 403 | `missing_scope` | Scope missing. |
| 403 | `tenant_locked` | Workspace suspended. The key remains valid. |

> **Note**
>
> A key’s scopes are set at creation. For an extra scope: a new key.

<a id="debit"></a>

## Rate limit

- A cap on calls per minute and per hour, set by the workspace’s plan.
- Shared by all the workspace’s keys and the MCP server.
- A call counts as one whatever its size (50 records at once: one call).
- Higher limit for a workspace: on request.

Every counted response carries, in headers, the counter closest to its limit:

| Header | Meaning |
| --- | --- |
| `x-ratelimit-limit` | The limit of this window (minute or hour). |
| `x-ratelimit-remaining` | The calls left in this window. |
| `x-ratelimit-reset` | Reset time, in seconds since 1970. |
| `retry-after` | On a 429: seconds until the full window resets (minute or hour, named in the message). |

- On overflow: 429 `rate_limited`. A refused call does not count.
- Unknown key (401): none of these headers.

<a id="quotas"></a>

On top of the rate limit, DAILY quotas per workspace count the work REQUESTED (a recipient skipped later still counts), in three families counted separately:

| Family | What it counts | Daily quota |
| --- | --- | --- |
| Templates | The recipients of a send, and sending a template from the MCP server | Set by the plan |
| Replies | Free-form WhatsApp or RCS messages, within the 24-hour window. Sending templates never takes their room. | Set by the plan |
| Records | Written contacts (one per contact, multi-contact calls included) | 20000 |

- Reset at midnight, Paris time.
- A request that would exceed the quota is refused entirely: 429 `quota_exceeded`, with retry-after until midnight. A smaller request may still go through.
- A new call with the same idempotency key does not count, whether it replays a finished send or hits one in progress (409). A send refused by the quota frees its key.
- Reads, catalogs and campaigns launched from the console have no quota. Neither does the MCP server, except sending a template, which counts as a template.
- Higher quota for a workspace: on request.

> **Note**
>
> Counters kept in the database and shared by every server copy: a deploy does not reset them.

<a id="erreurs"></a>

## Errors

Shape of a refusal:

_JSON_

```
{
  "error": "fenêtre de 24 h fermée : cette personne n’a pas écrit récemment. Utilisez un template (POST /v1/sends).",
  "code": "window_closed"
}
```

- error: sentence in French, for a human. code: stable identifier, for a program.
- A refusal carries the same code everywhere, as an error or as a skip reason in a send.
- Readable but malformed JSON body: invalid_body, faulty field in the message. Missing or unreadable record key: invalid_recipient, invalid_phone.

| Status | Meaning |
| --- | --- |
| 400 | Invalid body. |
| 401 | Key missing or invalid. |
| 403 | Scope missing, or workspace suspended. |
| 404 | Record, send or target not found. |
| 409 | The state of the record or workspace forbids the operation: opted out, blocked, no consent, contradictory keys, channel or number missing, ambiguous scenario name, idempotency key in use. |
| 422 | Valid body, but sending is impossible as things stand: window closed, unsendable target, unreadable category, record without a number, number unreachable over RCS, idempotency key already used, Meta refusal. |
| 429 | Rate limit or daily quota exceeded. |

Every code, when it happens and what to do, with Meta’s errors: [the error catalog](https://console.messagingme.app/developers/api/errors.en.md).

> **Caution**
>
> An unreadable JSON is read as an empty object: the refusal names what is missing, not the syntax. Always send Content-Type: application/json.
