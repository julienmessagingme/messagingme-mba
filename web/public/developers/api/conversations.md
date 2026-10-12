<!-- Version Markdown de https://console.messagingme.app/developers/api/conversations, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/conversations.en.md -->

# Conversations

Ce que vos contacts ont écrit et ce qui leur a été répondu, pour qu’une application réponde avec le contexte. Ouvert dans toutes les offres, sous le droit conversations:read, à cocher sur une clé neuve : les clés créées avant ce droit ne l’ont pas.

Sur cette page

|   |   |
| --- | --- |
| GET | [/v1/conversations](https://console.messagingme.app/developers/api/conversations.md#lister) : Liste les conversations, la plus récente d’abord, par pages. |
| GET | [/v1/conversations/{conversationId}](https://console.messagingme.app/developers/api/conversations.md#lire) : Lit une conversation : le contact, qui la tient, la fenêtre de 24 h. |
| GET | [/v1/conversations/{conversationId}/messages](https://console.messagingme.app/developers/api/conversations.md#messages) : Les messages d’une conversation, le plus récent d’abord, par pages. |
| GET | [/v1/messages/{messageId}](https://console.messagingme.app/developers/api/conversations.md#message) : Lit un message par son identifiant. |
| GET | [/v1/messages/{messageId}/media](https://console.messagingme.app/developers/api/conversations.md#media) : Télécharge le fichier d’un message reçu. |

<a id="lister"></a>

## GET /v1/conversations

Liste les conversations, la plus récente d’abord, par pages.

Droit : `conversations:read`

_Commande_

```
curl https://api.messagingme.app/v1/conversations?limit=20 \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### Réponse 200

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

| Champ | Sens |
| --- | --- |
| `needsReply=true` | Seulement les conversations « À traiter » : le contact attend une réponse de l’ÉQUIPE. Celles que tient votre application (mode « mon application répond ») n’y sont pas : elles arrivent par l’événement conversation.needs_reply. |
| `handledBy` | Qui tient la conversation : team (l’équipe), meta_agent (l’agent de Meta), automation (un scénario, un agent IA, ou votre application). |
| `windowExpiresAt` | La fin de la fenêtre de 24 h ouverte par le dernier message WhatsApp du contact ; null si elle est fermée. |

<a id="lire"></a>

## GET /v1/conversations/{conversationId}

Lit une conversation : le contact, qui la tient, la fenêtre de 24 h.

Droit : `conversations:read`

_Commande_

```
curl https://api.messagingme.app/v1/conversations/c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### Réponse 200

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

Une conversation d’un autre espace, ou d’un contact bloqué, rend 404 conversation_not_found.

<a id="messages"></a>

## GET /v1/conversations/{conversationId}/messages

Les messages d’une conversation, le plus récent d’abord, par pages.

Droit : `conversations:read`

_Commande_

```
curl https://api.messagingme.app/v1/conversations/c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b/messages?limit=50 \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### Réponse 200

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

| Champ | Sens |
| --- | --- |
| `id` | L’identifiant de Meta (wamid.…), le même que rendent POST /v1/messages/whatsapp, message.received et conversation.needs_reply. |
| `media` | Un fichier reçu (image, vocal, document) ; null sinon. expired : Meta ne l’a plus. |
| `status` | La livraison d’un message ENVOYÉ, selon les accusés de Meta : sent, delivered, read ou failed ; null pour un message reçu, et tant qu’aucun accusé n’est arrivé. Il ne recule jamais. statusAt : l’instant de l’accusé. error : le code et le motif d’un échec. |
| `transcription` | La transcription d’un vocal, quand elle a été faite : la lecture d’un modèle, pas ce que le client a dit. |

<a id="message"></a>

## GET /v1/messages/{messageId}

Lit un message par son identifiant.

Droit : `conversations:read`

_Commande_

```
curl https://api.messagingme.app/v1/messages/wamid.exemple-9031 \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### Réponse 200

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

Télécharge le fichier d’un message reçu.

Droit : `conversations:read`

_Commande_

```
curl https://api.messagingme.app/v1/messages/wamid.exemple-9031/media \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  --output photo.jpg
```

Les octets du fichier, avec son type (Content-Type). Les erreurs :

- 404 no_media : le message ne porte aucun fichier reçu ;
- 410 media_expired : Meta ne garde un fichier reçu que 7 jours, téléchargez-le avant ;
- 422 media_unavailable : Meta ne l’a pas rendu, ou il est trop lourd ; réessayez.

<a id="pagination"></a>

## Pagination

- limit : de 1 à 100, 50 par défaut. Le plus récent d’abord.
- nextCursor : à renvoyer tel quel dans cursor pour la page suivante (plus ancienne) ; null quand il n’y en a plus.
- Un curseur modifié rend 400 invalid_cursor, jamais une page qui recommence au début.

> **Note**
>
> Chaque appel compte au plafond d’appels de l’espace, pas au quota du jour. [Débit](https://console.messagingme.app/developers/api/reference.md#debit)
