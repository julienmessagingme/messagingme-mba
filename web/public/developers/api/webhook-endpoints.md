<!-- Version Markdown de https://console.messagingme.app/developers/api/webhook-endpoints, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/webhook-endpoints.en.md -->

# Gérer les webhooks sortants

Les adresses de votre application qui reçoivent les événements, gérées par une clé portant le droit webhooks:write. Ce sont les mêmes que dans Developers > Webhooks sortants, avec les mêmes contrôles et la même limite de l’offre. Le format des événements : [Webhooks sortants](https://console.messagingme.app/developers/api/webhooks.md).

Sur cette page

|   |   |
| --- | --- |
| GET | [/v1/webhooks](https://console.messagingme.app/developers/api/webhook-endpoints.md#lister) : Liste les adresses, la limite de l’offre et les types disponibles. |
| POST | [/v1/webhooks](https://console.messagingme.app/developers/api/webhook-endpoints.md#creer) : Inscrit une adresse et rend son secret, une seule fois. |
| GET | [/v1/webhooks/{webhookId}](https://console.messagingme.app/developers/api/webhook-endpoints.md#lire) : Lit une adresse et l’état de ses envois. |
| PATCH | [/v1/webhooks/{webhookId}](https://console.messagingme.app/developers/api/webhook-endpoints.md#modifier) : Change les types, la description, ou met l’adresse en pause. |
| POST | [/v1/webhooks/{webhookId}/rotate-secret](https://console.messagingme.app/developers/api/webhook-endpoints.md#rotation) : Renouvelle le secret ; l’ancien signe encore 24 h. |
| DELETE | [/v1/webhooks/{webhookId}](https://console.messagingme.app/developers/api/webhook-endpoints.md#supprimer) : Supprime une adresse. |
| POST | [/v1/webhooks/{webhookId}/test](https://console.messagingme.app/developers/api/webhook-endpoints.md#essai) : Envoie un événement d’essai signé et rend la réponse de l’application. |
| GET | [/v1/webhooks/{webhookId}/deliveries](https://console.messagingme.app/developers/api/webhook-endpoints.md#journal) : Lit le journal d’une adresse, le plus récent d’abord. |
| POST | [/v1/webhooks/deliveries/{deliveryId}/replay](https://console.messagingme.app/developers/api/webhook-endpoints.md#rejeu) : Rejoue un envoi terminé, avec le même corps. |
| POST | [/v1/webhooks/{webhookId}/replay-failures](https://console.messagingme.app/developers/api/webhook-endpoints.md#rejeu-echecs) : Rejoue les envois en échec depuis une date. |

<a id="lister"></a>

## GET /v1/webhooks

Liste les adresses, la limite de l’offre et les types disponibles.

Droit : `webhooks:write`

_Commande_

```
curl https://api.messagingme.app/v1/webhooks \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### Réponse 200

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

limit : les adresses actives de l’offre, null sans limite. Le secret n’est jamais relu.

<a id="creer"></a>

## POST /v1/webhooks

Inscrit une adresse et rend son secret, une seule fois.

Droit : `webhooks:write`

_Commande_

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

### Réponse 201

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

> **Attention**
>
> Le secret n’est montré qu’ici : rangez-le dans une variable d’environnement de votre application.

- url : https, joignable depuis Internet. Elle ne se modifie pas ensuite : supprimez et recréez.
- types : absents, tous sauf les trois accusés de livraison.

### Erreurs

| Statut | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | Corps hors du format, ou adresse refusée (http, hôte interne). |
| 402 | `plan_limit_reached` | Limite d’adresses actives de l’offre atteinte. |

<a id="lire"></a>

## GET /v1/webhooks/{webhookId}

Lit une adresse et l’état de ses envois.

Droit : `webhooks:write`

### Réponse 200

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

| Statut | Code | Cause |
| --- | --- | --- |
| 404 | `webhook_not_found` | Adresse inconnue de cet espace. |

<a id="modifier"></a>

## PATCH /v1/webhooks/{webhookId}

Change les types, la description, ou met l’adresse en pause.

Droit : `webhooks:write`

active à false met l’adresse en pause ; true la rallume, dans la limite de l’offre.

_Corps_

```
{
  "active": false
}
```

### Réponse

L’adresse, comme GET /v1/webhooks/{webhookId}.

| Statut | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | Corps hors du format. |
| 404 | `webhook_not_found` | Adresse inconnue de cet espace. |
| 402 | `plan_limit_reached` | Réactivation au-delà de la limite de l’offre. |

<a id="rotation"></a>

## POST /v1/webhooks/{webhookId}/rotate-secret

Renouvelle le secret ; l’ancien signe encore 24 h.

Droit : `webhooks:write`

Rend { secret, previousSecretValidUntil } : l’ancien secret signe encore 24 h, le temps de mettre à jour l’application.

| Statut | Code | Cause |
| --- | --- | --- |
| 404 | `webhook_not_found` | Adresse inconnue de cet espace. |

<a id="supprimer"></a>

## DELETE /v1/webhooks/{webhookId}

Supprime une adresse.

Droit : `webhooks:write`

204 sans corps. Les envois en cours de cette adresse s’arrêtent.

| Statut | Code | Cause |
| --- | --- | --- |
| 404 | `webhook_not_found` | Adresse inconnue de cet espace. |

<a id="essai"></a>

## POST /v1/webhooks/{webhookId}/test

Envoie un événement d’essai signé et rend la réponse de l’application.

Droit : `webhooks:write`

Envoie tout de suite un événement test signé, même à une adresse en pause, et rend { eventId, delivered, statusCode, response }.

| Statut | Code | Cause |
| --- | --- | --- |
| 404 | `webhook_not_found` | Adresse inconnue de cet espace. |

<a id="journal"></a>

## GET /v1/webhooks/{webhookId}/deliveries

Lit le journal d’une adresse, le plus récent d’abord.

Droit : `webhooks:write`

_Commande_

```
curl https://api.messagingme.app/v1/webhooks/{webhookId}/deliveries?limit=20 \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### Réponse 200

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

- limit : 1 à 100, 50 par défaut. before : une date ISO, celle que rend nextBefore pour la page suivante.
- status : pending (en cours ou en réessai), delivered, failed. body : le corps envoyé, octet pour octet ; il porte des données de contacts.

| Statut | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | limit ou before hors du format. |
| 404 | `webhook_not_found` | Adresse inconnue de cet espace. |

<a id="rejeu"></a>

## POST /v1/webhooks/deliveries/{deliveryId}/replay

Rejoue un envoi terminé, avec le même corps.

Droit : `webhooks:write`

202 { replayed: true } : l’envoi repart avec le même corps et le même identifiant d’événement (votre application dédoublonne).

| Statut | Code | Cause |
| --- | --- | --- |
| 404 | `delivery_not_found` | Identifiant qui n’est pas celui d’un envoi. |
| 409 | `delivery_not_replayable` | Envoi inconnu de cet espace, encore en cours, ou un essai : rien à rejouer. |

<a id="rejeu-echecs"></a>

## POST /v1/webhooks/{webhookId}/replay-failures

Rejoue les envois en échec depuis une date.

Droit : `webhooks:write`

_Commande_

```
curl -X POST https://api.messagingme.app/v1/webhooks/{webhookId}/replay-failures \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "since": "2026-10-09T00:00:00Z"
}'
```

202 { replayed } : le nombre d’envois en échec relancés depuis since, 500 au plus par appel.

| Statut | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | since absent ou hors du format. |
| 404 | `webhook_not_found` | Adresse inconnue de cet espace. |
