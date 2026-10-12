<!-- Markdown version of https://console.messagingme.app/developers/api/conversations, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/conversations.md -->

# Conversations

What your contacts wrote and what was answered, so that an app replies with the context. Open in every plan, under the conversations:read scope, to tick on a new key: keys created before this scope do not have it.

On this page

|   |   |
| --- | --- |
| GET | [/v1/conversations](https://console.messagingme.app/developers/api/conversations.en.md#lister) : Lists conversations, most recent first, page by page. |
| GET | [/v1/conversations/{conversationId}](https://console.messagingme.app/developers/api/conversations.en.md#lire) : Reads a conversation: the contact, who handles it, the 24-hour window. |
| GET | [/v1/conversations/{conversationId}/messages](https://console.messagingme.app/developers/api/conversations.en.md#messages) : A conversation’s messages, most recent first, page by page. |
| GET | [/v1/messages/{messageId}](https://console.messagingme.app/developers/api/conversations.en.md#message) : Reads a message by its ID. |
| GET | [/v1/messages/{messageId}/media](https://console.messagingme.app/developers/api/conversations.en.md#media) : Downloads the file of a received message. |

<a id="lister"></a>

## GET /v1/conversations

Lists conversations, most recent first, page by page.

Scope: `conversations:read`

_Command_

```
curl https://api.messagingme.app/v1/conversations?limit=20 \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### 200 response

_JSON_

```
{
  "data": [
    {
      "id": "c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b",
      "contact": {
        "id": "5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01",
        "phone": "+33612345678",
        "name": "Claire",
        "externalId": "crm-7781"
      },
      "lastMessageAt": "2026-10-08T09:58:02.123Z",
      "lastDirection": "in",
      "windowExpiresAt": "2026-10-09T09:58:02.123Z",
      "handledBy": "automation",
      "needsReply": false,
      "archived": false
    }
  ],
  "nextCursor": "MjAyNi0xMC0wOFQwOTo1ODowMi4xMjM0NTZafGM0ZTFiMmEzLTlkOGYtNGU3YS1hNmI1LTFjMmQzZTRmNWE2Yg"
}
```

| Field | Meaning |
| --- | --- |
| `needsReply=true` | Only conversations “To handle”: the contact awaits an answer from the TEAM. Those your app handles (“my app answers” mode) are not there: they come through the conversation.needs_reply event. |
| `handledBy` | Who handles the conversation: team, meta_agent (Meta’s agent), automation (a scenario, an AI agent, or your app). |
| `windowExpiresAt` | The end of the 24-hour window opened by the contact’s last WhatsApp message; null when closed. |

<a id="lire"></a>

## GET /v1/conversations/{conversationId}

Reads a conversation: the contact, who handles it, the 24-hour window.

Scope: `conversations:read`

_Command_

```
curl https://api.messagingme.app/v1/conversations/c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### 200 response

_JSON_

```
{
  "id": "c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b",
  "contact": {
    "id": "5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01",
    "phone": "+33612345678",
    "name": "Claire",
    "externalId": "crm-7781"
  },
  "lastMessageAt": "2026-10-08T09:58:02.123Z",
  "lastDirection": "in",
  "windowExpiresAt": "2026-10-09T09:58:02.123Z",
  "handledBy": "automation",
  "needsReply": false,
  "archived": false
}
```

A conversation of another workspace, or of a blocked contact, returns 404 conversation_not_found.

<a id="messages"></a>

## GET /v1/conversations/{conversationId}/messages

A conversation’s messages, most recent first, page by page.

Scope: `conversations:read`

_Command_

```
curl https://api.messagingme.app/v1/conversations/c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b/messages?limit=50 \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### 200 response

_JSON_

```
{
  "data": [
    {
      "id": "wamid.exemple-9031",
      "conversationId": "c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b",
      "direction": "in",
      "channel": "whatsapp",
      "type": "image",
      "text": "Voici la photo du colis",
      "buttonPayload": null,
      "transcription": null,
      "media": {
        "mimeType": "image/jpeg",
        "filename": null,
        "expired": false
      },
      "status": null,
      "statusAt": null,
      "error": null,
      "createdAt": "2026-10-08T09:58:02.123Z"
    },
    {
      "id": "wamid.exemple-8412",
      "conversationId": "c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b",
      "direction": "out",
      "channel": "whatsapp",
      "type": "text",
      "text": "Bonjour Claire, elle part demain.",
      "buttonPayload": null,
      "transcription": null,
      "media": null,
      "status": "read",
      "statusAt": "2026-10-08T09:56:12.000Z",
      "error": null,
      "createdAt": "2026-10-08T09:55:40.000Z"
    }
  ],
  "nextCursor": null
}
```

| Field | Meaning |
| --- | --- |
| `id` | Meta’s ID (wamid.…), the same as returned by POST /v1/messages/whatsapp, message.received and conversation.needs_reply. |
| `media` | A received file (image, voice note, document); null otherwise. expired: Meta no longer has it. |
| `status` | The delivery of a SENT message, from Meta’s receipts: sent, delivered, read or failed; null for a received message, and until a receipt arrives. It never goes back. statusAt: the receipt’s time. error: a failure’s code and reason. |
| `transcription` | A voice note’s transcription, when made: a model’s reading, not what the customer said. |

<a id="message"></a>

## GET /v1/messages/{messageId}

Reads a message by its ID.

Scope: `conversations:read`

_Command_

```
curl https://api.messagingme.app/v1/messages/wamid.exemple-9031 \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### 200 response

_JSON_

```
{
  "id": "wamid.exemple-9031",
  "conversationId": "c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b",
  "direction": "in",
  "channel": "whatsapp",
  "type": "image",
  "text": "Voici la photo du colis",
  "buttonPayload": null,
  "transcription": null,
  "media": {
    "mimeType": "image/jpeg",
    "filename": null,
    "expired": false
  },
  "status": null,
  "statusAt": null,
  "error": null,
  "createdAt": "2026-10-08T09:58:02.123Z"
}
```

<a id="media"></a>

## GET /v1/messages/{messageId}/media

Downloads the file of a received message.

Scope: `conversations:read`

_Command_

```
curl https://api.messagingme.app/v1/messages/wamid.exemple-9031/media \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  --output photo.jpg
```

The file’s bytes, with its type (Content-Type). The errors:

- 404 no_media: the message carries no received file;
- 410 media_expired: Meta keeps a received file for 7 days only, download it before;
- 422 media_unavailable: Meta did not return it, or it is too large; retry.

<a id="pagination"></a>

## Pagination

- limit: 1 to 100, 50 by default. Most recent first.
- nextCursor: send it back as is in cursor for the next (older) page; null when there is none.
- A modified cursor returns 400 invalid_cursor, never a page that starts over.

> **Note**
>
> Each call counts toward the workspace call cap, not the daily quota. [Rate limits](https://console.messagingme.app/developers/api/reference.en.md#debit)
