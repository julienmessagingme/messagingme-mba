<!-- Version Markdown de https://console.messagingme.app/developers/api/messages, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/messages.en.md -->

# Messages

Un texte, à une fiche existante, envoyé tout de suite. Pour une liste de destinataires, un template ou un scénario : [Envois](https://console.messagingme.app/developers/api/sends.md).

Sur cette page

|   |   |
| --- | --- |
| POST | [/v1/messages](https://console.messagingme.app/developers/api/messages.md#message-meta) : Envoie un message au format de Meta : image, document, lieu, boutons, liste, bouton lien. |
| POST | [/v1/messages/whatsapp](https://console.messagingme.app/developers/api/messages.md#message-whatsapp) : Envoie tout de suite un texte WhatsApp à une fiche existante. |
| POST | [/v1/messages/rcs](https://console.messagingme.app/developers/api/messages.md#message-rcs) : Envoie tout de suite un texte RCS à une fiche existante. |

<a id="messages-simples"></a>

## Message ou envoi

|  | Message | Envoi |
| --- | --- | --- |
| Destinataires | Une fiche | 1 à 50 |
| Contenu | Un texte | Template, scénario, bloc ou message RCS |
| Traitement | Synchrone : la réponse 200 porte le message | Asynchrone : GET /v1/sends/{sendId} |
| Fiche inconnue | Refusée | Créée avec un phone, sauf ouverture whatsapp_session |
| Idempotence | Non | [Oui, clé obligatoire](https://console.messagingme.app/developers/api/concepts.md#idempotence) |

- Le message apparaît dans l’Inbox si journal vaut recorded.
- Il prend le fil : le scénario en cours s’arrête, l’agent de Meta cesse de répondre.

> **Attention**
>
> Pas de clé d’idempotence : rejouer l’appel envoie un second message.

<a id="message-whatsapp"></a>

## POST /v1/messages/whatsapp

Envoie tout de suite un texte WhatsApp à une fiche existante.

Droit : `sends:create`

### Requête

| Champ | Obligatoire | Description |
| --- | --- | --- |
| `contactId` : uuid | Une clé au moins | L’identifiant de la fiche, rendu à sa création. [Désigner une personne](https://console.messagingme.app/developers/api/concepts.md#identification) |
| `externalId` : string | Une clé au moins | Votre identifiant de la personne, unique par espace, 512 caractères au plus. |
| `phone` : string | Une clé au moins | Le numéro, au format international (+33…). |
| `bsuid` : string | Une clé au moins | L’identifiant WhatsApp d’une personne sans numéro visible. |
| `text` : string | Oui | Le texte, 4096 caractères au plus. |
| `consent` : string | Non | Sur un numéro relié par QR code, un message écrit en premier (personne sans conversation, ou hors des 24 h) exige une fiche opted_in : opted_in le déclare, écrit sur la fiche avant l’envoi. Sans effet ailleurs. Valeurs : `opted_in`. [Consentement et STOP](https://console.messagingme.app/developers/api/concepts.md#consentement) |
| `consentSource` : string | Non | D’où vient le consentement, 100 caractères au plus. Absent : api. |

Une clé inconnue est refusée : 400 `invalid_body`.

_Commande_

```
curl -X POST https://api.messagingme.app/v1/messages/whatsapp \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "externalId": "crm-7781",
  "text": "Votre commande 8412 est prête, vous pouvez passer la retirer."
}'
```

### Réponse 200

_JSON_

```
{
  "messageId": "wamid.exemple-8412",
  "conversationId": "c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b",
  "channel": "whatsapp",
  "journal": "recorded"
}
```

Dans la réponse 200, conversationId est toujours renseigné.

Sur un numéro relié par QR code (application WhatsApp Business), un texte à une personne sans conversation, ou hors des 24 h, est écrit en premier : la réponse est 202, status vaut queued, id est celui du message en file et scheduledAt son départ prévu ; conversationId vaut null tant que la personne n’a pas de conversation. Le message part espacé, compte dans les messages du mois, et exige une fiche opted_in, ou consent à opted_in dans l’appel. Une personne sans fiche, désignée par phone, reçoit sa fiche au passage. Le même texte au même numéro, rejoué dans la minute, n’est mis en file qu’une fois.

Après acceptation par le fournisseur, journal vaut unrecorded si l’écriture dans l’Inbox échoue encore après une reprise. Le statut reste 200 et messageId identifie le message : ne rejouez pas cet appel.

### Erreurs

Dans l’ordre où elles sont vérifiées :

| Statut | Code | Cause |
| --- | --- | --- |
| 404 | `unknown_contact` | Fiche inconnue. |
| 409 | `blocked_contact` | Fiche bloquée, ou sans adresse WhatsApp. |
| 422 | `window_closed` | Fenêtre de 24 h fermée. |
| 409 | `opted_out` | Fiche désabonnée. |
| 409 | `no_whatsapp_number` | Espace sans numéro WhatsApp. |
| 409 | `number_unlinked` | Numéro délié depuis l’Accueil. |
| 409 | `number_suspended` | Abonnement du numéro fourni impayé ou terminé. |
| 409 | `no_consent` | Numéro relié par QR code : message écrit en premier à une fiche qui n’est pas opted_in, sans consent. |
| 422 | `no_phone` | Numéro relié par QR code : message écrit en premier à une personne sans numéro connu. |
| 402 | `plan_limit_reached` | Numéro relié par QR code : messages du mois, ou contacts de l’offre, atteints. |
| 400, 409 | `invalid_recipient` `invalid_phone` `identity_conflict` | Clés de fiche absentes, illisibles ou contradictoires : [Désigner une personne](https://console.messagingme.app/developers/api/concepts.md#identification) |

### Notes

Fenêtre fermée : seul un template peut partir (sur un numéro relié par QR code, le texte est écrit en premier). [La fenêtre de 24 h](https://console.messagingme.app/developers/api/concepts.md#fenetre-24h)

<a id="message-meta"></a>

## POST /v1/messages

Envoie un message au format de Meta : image, document, lieu, boutons, liste, bouton lien.

Droit : `sends:create`

Le corps de Meta tel quel, dans la fenêtre de 24 h : un exemple de la documentation de Meta (Cloud API, messages) passe, pour les types ci-dessous et avec ses médias en link. to est le numéro avec l’indicatif du pays, retrouvé sur sa fiche ; contactId ou externalId peuvent le remplacer.

- Types : text, image, video, audio, document, location, reaction, interactive (button, list, cta_url).
- Un média passe par une URL https publique (link) : Meta va chercher le fichier.
- Les bornes sont celles de Meta (3 boutons, titre de 20 caractères, 10 lignes de liste) ; un champ inconnu est refusé en invalid_body, avec le champ fautif.
- Le contact qui touche un bouton revient dans l’événement message.received, avec son id.

_Commande_

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

### Réponse 200

_JSON_

```
{
  "messageId": "wamid.exemple-8412",
  "conversationId": "c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b",
  "channel": "whatsapp",
  "journal": "recorded"
}
```

### Erreurs

Les mêmes que POST /v1/messages/whatsapp, dans le même ordre.

<a id="message-rcs"></a>

## POST /v1/messages/rcs

Envoie tout de suite un texte RCS à une fiche existante.

Droit : `sends:create`

### Requête

| Champ | Obligatoire | Description |
| --- | --- | --- |
| `contactId` : uuid | Une clé au moins | L’identifiant de la fiche, rendu à sa création. [Désigner une personne](https://console.messagingme.app/developers/api/concepts.md#identification) |
| `externalId` : string | Une clé au moins | Votre identifiant de la personne, unique par espace, 512 caractères au plus. |
| `phone` : string | Une clé au moins | Le numéro, au format international (+33…). |
| `bsuid` : string | Une clé au moins | L’identifiant WhatsApp d’une personne sans numéro visible. |
| `text` : string | Oui | Le texte, 3072 caractères au plus. |

Une clé inconnue est refusée : 400 `invalid_body`.

_Commande_

```
curl -X POST https://api.messagingme.app/v1/messages/rcs \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "phone": "+33612345678",
  "text": "Votre rendez-vous de jeudi 14 h est confirmé."
}'
```

### Réponse 200

Celle de POST /v1/messages/whatsapp, channel à rcs. conversationId vaut null si le fil ne peut pas être ouvert après acceptation ; journal vaut alors unrecorded. Ne rejouez pas l’appel.

### Erreurs

Dans l’ordre où elles sont vérifiées :

| Statut | Code | Cause |
| --- | --- | --- |
| 404 | `unknown_contact` | Fiche inconnue. |
| 422 | `no_phone` | Fiche sans numéro. |
| 409 | `blocked_contact` | Fiche bloquée. |
| 409 | `opted_out` | Désabonnée, en général ou du RCS. |
| 409 | `no_consent` | Ni opted_in, ni jamais écrit. |
| 409 | `rcs_not_enabled` | Canal RCS inactif sur l’espace. |
| 422 | `rcs_unreachable` | Numéro connu comme injoignable en RCS. |
| 400, 409 | `invalid_recipient` `invalid_phone` `identity_conflict` | Clés de fiche absentes, illisibles ou contradictoires : [Désigner une personne](https://console.messagingme.app/developers/api/concepts.md#identification) |

### Notes

- Pas de fenêtre de 24 h en RCS.
- Joignabilité RCS apprise après coup : le premier message vers un numéro sans RCS est accepté, son échec est enregistré (Sécurité > Journal des erreurs), le suivant est refusé en `rcs_unreachable`.
