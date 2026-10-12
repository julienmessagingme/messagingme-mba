<!-- Version Markdown de https://console.messagingme.app/developers/api/sends, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/sends.en.md -->

# Envois

Une cible (template, scénario, bloc ou message RCS) vers 1 à 50 destinataires, en tâche de fond. Chaque envoi apparaît dans Campagnes.

Sur cette page

|   |   |
| --- | --- |
| POST | [/v1/sends](https://console.messagingme.app/developers/api/sends.md#envoi) : Lance un envoi asynchrone et idempotent, vers 1 à 50 destinataires. |
| GET | [/v1/sends/{sendId}](https://console.messagingme.app/developers/api/sends.md#suivi) : Lit l’état et les résultats d’un envoi. |

<a id="envoi"></a>

## POST /v1/sends

Lance un envoi asynchrone et idempotent, vers 1 à 50 destinataires.

Droit : `sends:create`

> **Obligatoire**
>
> Une clé d’idempotence : en-tête Idempotency-Key ou champ idempotencyKey. [Idempotence](https://console.messagingme.app/developers/api/concepts.md#idempotence)

### Requête

| Champ | Obligatoire | Description |
| --- | --- | --- |
| `idempotencyKey` : string | Oui, ici ou en en-tête Idempotency-Key | La clé qui rend l’appel rejouable sans double envoi, 255 caractères au plus. [Idempotence](https://console.messagingme.app/developers/api/concepts.md#idempotence) |
| `target` : object | Oui | Ce qui part : un template, un scénario, un bloc ou un message RCS. |
| `recipients` : object[] | Oui | De 1 à 50 destinataires. |
| `params` : object[] | Non | Les variables du template qui part. |
| `category` : string | Oui, sauf pour un template | Refusée sur un template : sa catégorie est lue chez Meta. Valeurs : `marketing` , `utility`. |
| `ratePerMinute` : integer | Non | De 1 à 80 messages par minute. Le plafond du canal s’applique ensuite, il peut être plus bas. |
| `phoneNumberId` : string | Non | Le numéro WhatsApp qui envoie. Absent : le numéro par défaut de l’espace. Ignoré pour un message RCS. |

Une clé inconnue est refusée : 400 `invalid_body`.

_Commande : un template, une variable par destinataire_

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

#### Types de cible

target porte exactement une clé :

| Clé | Valeur | Canal |
| --- | --- | --- |
| `template` | un objet : name et language d’un template approuvé (GET /v1/templates) | WhatsApp |
| `scenario` | le code scn_ ou le nom d’un scénario (GET /v1/scenarios) | celui de son premier envoi |
| `node` | le code nod_ d’un bloc (Contenu > Blocs, ou entryNode dans GET /v1/scenarios) | celui de son premier envoi |
| `rcsMessage` | le nom d’un message de Contenu > Messages RCS (GET /v1/rcs-messages) | RCS, par l’agent RCS de l’espace |

<a id="destinataires"></a>

#### Destinataires

Chaque élément de recipients :

| Champ | Obligatoire | Description |
| --- | --- | --- |
| `contactId` : uuid | Une clé au moins | L’identifiant de la fiche, rendu à sa création. [Désigner une personne](https://console.messagingme.app/developers/api/concepts.md#identification) |
| `externalId` : string | Une clé au moins | Votre identifiant de la personne, unique par espace, 512 caractères au plus. |
| `phone` : string | Une clé au moins | Le numéro, au format international (+33…). |
| `bsuid` : string | Une clé au moins | L’identifiant WhatsApp d’une personne sans numéro visible. |
| `consent` : string | Non | Écrit sur la fiche avant le tri. opted_out désabonne et écarte ce destinataire. Valeurs : `opted_in` , `opted_out`. [Consentement et STOP](https://console.messagingme.app/developers/api/concepts.md#consentement) |
| `consentSource` : string | Non | D’où vient le consentement, 100 caractères au plus. Absent : api. |
| `variables` : object | Non | Des valeurs propres à ce destinataire, jamais écrites sur la fiche. 50 au plus, de 1024 caractères au plus ; noms en lettres, chiffres, _, . ou -. |

Une clé inconnue est ignorée.

- Destinataire inconnu avec un phone : fiche créée, sauf ouverture whatsapp_session. Sinon écarté (`unknown_contact`).
- Destinataire mal formé : écarté (`invalid_recipient`, `invalid_phone`), l’envoi continue.

<a id="parametres"></a>

#### Paramètres et variables

Chaque élément de params :

| Champ | Obligatoire | Description |
| --- | --- | --- |
| `position` : integer | Oui | La variable du template : 1 pour {{1}}. Positions de 1 à N, sans trou. |
| `source` : object | Oui | D’où vient la valeur. |
| `fallback` : string | Non | La valeur de repli, quand la source est vide. |

Une clé inconnue est ignorée.

| source.type | Avec | Lit |
| --- | --- | --- |
| `field` | `key` | un champ de la fiche, par sa clé |
| `attribute` | `key` : `name` , `phone` , `bsuid` , `wa_id` | un attribut de la fiche |
| `now` |  | la date du jour (JJ/MM/AAAA, heure de Paris) |
| `literal` | `value` | un texte fixe |
| `variable` | `key` | une variable du destinataire (recipients[].variables), sur un template seulement |

Selon la cible :

| Cible | params | recipients[].variables |
| --- | --- | --- |
| template | Une entrée par variable du corps (GET /v1/templates). Autre nombre : 422 `unsendable_target`. | Lues par la source variable. Absente et sans fallback : destinataire écarté (`missing_variable`). |
| scénario qui ouvre par un template | Paramètrent ce template (openingTemplate), toute source sauf variable. | Refusées (400 `invalid_body`). |
| bloc, scénario qui ouvre en RCS | Refusés (400 `invalid_body`). Un bloc remplit son template avec les champs associés à ses variables dans la console. | Refusées (400 `invalid_body`). |
| message RCS | Refusés (400 `invalid_body`). | `{{commande}}` : variables.commande, sinon le champ de fiche commande, sinon vide. |

<a id="ouverture"></a>

#### Message d’ouverture

Le premier message que la cible fait partir décide des règles, pas le type du bloc visé. La réponse le rend dans opening.

| Premier envoi | opening | Règle |
| --- | --- | --- |
| un template | `whatsapp_template` | Part vers qui n’a pas écrit. |
| un bloc RCS | `rcs` | Part vers qui n’a pas écrit. Fiche sans numéro : écartée (`no_phone`). |
| un message rapide, une question, un formulaire, un agent | `whatsapp_session` | Fenêtre de 24 h exigée par destinataire, sinon écarté (`window_closed`). |
| une attente avant tout envoi, rien, plusieurs templates possibles, un template sans nom | (aucun) | 422 `unsendable_target`, raison dans le message. |

- Une seule branche capable d’un message de session : la fenêtre est exigée pour tous.
- Scénario en whatsapp_session : refusé. Viser son bloc d’entrée (cible node, code dans entryNode).
- Un bloc admet les trois ouvertures.
- Un envoi joue la version publiée : un scénario jamais publié est refusé.

<a id="categorie"></a>

#### Catégorie

| Cible | category |
| --- | --- |
| template | Refusée : lue chez Meta, marketing ou utility. Illisible ou autre : 422 `template_category_unknown`. |
| scénario, bloc, message RCS | Obligatoire. Premier message en template marketing (scénario, bloc) : marketing, même déclaré utility. |

| Catégorie | Destinataires écartés |
| --- | --- |
| `marketing` | Tout destinataire qui n’est pas opted_in (`no_consent`). |
| `utility` | Les désabonnés seulement. |

### Réponse 201

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

| Champ | Sens |
| --- | --- |
| `opening` | [Message d’ouverture](https://console.messagingme.app/developers/api/sends.md#ouverture) |
| `recipientCount` | Destinataires retenus. |
| `created`, `matched` | Fiches créées, fiches trouvées. |
| `skipped` | Un élément par destinataire écarté : index dans recipients et motif. 200 au plus ; skippedTotal donne le total. |

Motifs d’écart : `invalid_recipient` , `invalid_phone` , `unknown_contact` , `duplicate` , `identity_conflict` , `blocked_contact` , `opted_out` , `no_consent` , `window_closed` , `missing_variable` , `no_phone` , `plan_limit_reached`.

### Erreurs

| Statut | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | Corps, cible ou params mal formés ; category absente ou en trop ; phoneNumberId inconnu de l’espace. |
| 400 | `idempotency_key_required` | Clé d’idempotence absente. |
| 422 | `idempotency_key_reused` | Clé déjà utilisée pour un autre corps. |
| 409 | `idempotency_in_progress` | Envoi en cours avec cette clé. |
| 409 | `no_whatsapp_number` | Aucun numéro WhatsApp sur l’espace (sauf message RCS). |
| 409 | `number_unlinked` | Numéro WhatsApp délié depuis l’Accueil, et premier message en WhatsApp. Rien n’est créé. Une cible qui ouvre en RCS part. |
| 409 | `number_suspended` | Abonnement du numéro fourni impayé ou terminé, et premier message en WhatsApp. Rien n’est créé. |
| 404 | `template_not_found` | Template absent, non approuvé, ou d’une autre langue. |
| 422 | `template_category_unknown` | Catégorie du template illisible, ou ni marketing ni utility. |
| 404 | `scenario_not_found` | Scénario introuvable. |
| 409 | `scenario_ambiguous` | Plusieurs scénarios portent ce nom : utiliser le code scn_. |
| 404 | `node_not_found` | Bloc introuvable dans les scénarios publiés. |
| 404 | `rcs_message_not_found` | Message RCS introuvable. |
| 409 | `rcs_not_enabled` | Canal RCS inactif, cible rcsMessage. |
| 422 | `unsendable_target` | La cible ne peut pas partir ainsi ; raison dans le message. |

### Exemples de cibles

_Corps : scénario qui ouvre par un template (ses deux params)_

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

_Corps : bloc, dans la fenêtre_

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

_Commande : message RCS de la bibliothèque_

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

Lit l’état et les résultats d’un envoi.

Droit : `sends:create`

### Requête

sendId, dans le chemin : celui de la réponse 201.

_Commande_

```
curl https://api.messagingme.app/v1/sends/0b9d7a42-3c1e-4f5a-8d2b-6e7f8a9b0c1d \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### Réponse 200

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

| Champ | Sens |
| --- | --- |
| `status` | État de l’envoi, dont running, paused et completed. |
| `counts` | Destinataires retenus, par statut. Les destinataires écartés à la création n’y figurent pas : seulement dans skipped et skippedTotal de la réponse 201. |
| `recipients` | Une ligne par destinataire retenu, 500 au plus ; recipientsTotal donne le total. |
| `error` | Sur une ligne failed : message et metaCode. failed couvre aussi un échec de livraison signalé après l’envoi. |
| `channel` | Scénario ou bloc : la ligne décrit le départ du parcours. channel : son canal d’ouverture ; messageId et delivery : null. La suite se lit dans la console. |

### Erreurs

| Statut | Code | Cause |
| --- | --- | --- |
| 404 | `send_not_found` | Envoi inconnu. |
