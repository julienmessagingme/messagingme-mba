<!-- Version Markdown de https://console.messagingme.app/developers/api/catalogs, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/catalogs.en.md -->

# Catalogues

Ce qu’un envoi (POST /v1/sends) peut faire partir. Chaque template et message RCS listé est envoyable ; un scénario le dit par opening.

Sur cette page

|   |   |
| --- | --- |
| GET | [/v1/templates](https://console.messagingme.app/developers/api/catalogs.md#templates) : Liste les templates WhatsApp approuvés et envoyables. |
| GET | [/v1/scenarios](https://console.messagingme.app/developers/api/catalogs.md#scenarios) : Liste les scénarios publiés et leur message d’ouverture. |
| GET | [/v1/rcs-messages](https://console.messagingme.app/developers/api/catalogs.md#messages-rcs) : Liste les messages RCS de la bibliothèque. |

<a id="templates"></a>

## GET /v1/templates

Liste les templates WhatsApp approuvés et envoyables.

Droit : `sends:create`

_Commande_

```
curl https://api.messagingme.app/v1/templates \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### Réponse 200

_JSON_

```
{
  "templates": [
    {
      "name": "confirmation_commande",
      "language": "fr",
      "category": "utility",
      "header": "none",
      "variables": [
        {
          "position": 1,
          "source": {
            "type": "field",
            "key": "prenom"
          }
        },
        {
          "position": 2,
          "source": null
        }
      ]
    }
  ]
}
```

| Champ | Sens |
| --- | --- |
| `variables` | Une entrée par variable du corps, donc par entrée attendue dans params. source : le champ associé dans la console, à recopier tel quel dans params ; null sinon. |
| `header` | Type d’en-tête. Carrousel : none (visuels par carte). |

Absents de la liste, car un envoi ou Meta les refuserait :

- catégorie autre que marketing ou utility ;
- en-tête de localisation, ou en-tête texte à variable ;
- bouton de lien à variable dans l’adresse (hors liens de suivi des clics de la console) ;
- carrousel dont une carte ou un lien porte une variable ;
- visuel d’en-tête ou de carte illisible par la console.

> **Note**
>
> Lecture en direct chez Meta : une panne rend une erreur, jamais une liste vide. [Erreurs](https://console.messagingme.app/developers/api/reference.md#erreurs)

<a id="scenarios"></a>

## GET /v1/scenarios

Liste les scénarios publiés et leur message d’ouverture.

Droit : `sends:create`

_Commande_

```
curl https://api.messagingme.app/v1/scenarios \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### Réponse 200

_JSON_

```
{
  "scenarios": [
    {
      "code": "scn_k3f9qa_01J8Z3M4V6X7Y8Z9A0B1C2D3E4",
      "name": "Suivi de commande",
      "opening": "whatsapp_template",
      "openingTemplate": {
        "name": "confirmation_commande",
        "language": "fr"
      },
      "entryNode": "nod_k3f9qa_01J8Z3Q7Y9Z0A1B2C3D4E5F6G7",
      "publishedAt": "2026-09-20T08:30:00.000Z"
    },
    {
      "code": "scn_k3f9qa_01J8Z3P6X8Y9Z0A1B2C3D4E5F6",
      "name": "Relance dans la fenêtre",
      "opening": "whatsapp_session",
      "openingTemplate": null,
      "entryNode": "nod_k3f9qa_01J8Z3N5W7X8Y9Z0A1B2C3D4E5",
      "publishedAt": null
    }
  ]
}
```

| Champ | Sens |
| --- | --- |
| `opening` | Même règle que POST /v1/sends. rcs ou whatsapp_template : cible scenario (code ou nom). whatsapp_session : cible node sur entryNode. null : aucune des deux ; un autre bloc du scénario, en cible node, est jugé pour lui-même. [Message d’ouverture](https://console.messagingme.app/developers/api/sends.md#ouverture) |
| `openingTemplate` | Ouverture whatsapp_template : le template que params paramètre ; null sinon. Ses variables : GET /v1/templates, même nom et même langue. Autre nombre dans params : 422 `unsendable_target`. |
| `entryNode` | Code nod_ du bloc d’entrée, pour une cible node : même ouverture que le scénario. Seul chemin d’une ouverture whatsapp_session. null si le bloc n’a pas de code public. |
| `publishedAt` | null pour un scénario publié avant que cette date soit enregistrée. |

<a id="messages-rcs"></a>

## GET /v1/rcs-messages

Liste les messages RCS de la bibliothèque.

Droit : `sends:create`

_Commande_

```
curl https://api.messagingme.app/v1/rcs-messages \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### Réponse 200

_JSON_

```
{
  "rcsMessages": [
    {
      "name": "rappel-rdv",
      "kind": "card",
      "variables": [
        "prenom",
        "date_rdv"
      ]
    }
  ]
}
```

| Champ | Sens |
| --- | --- |
| `name` | Valeur de la cible rcsMessage. |
| `kind` | `text`, `card` ou `carousel`. |
| `variables` | Noms entre doubles accolades utilisés par le message. |
