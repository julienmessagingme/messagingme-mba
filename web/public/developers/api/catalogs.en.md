<!-- Markdown version of https://console.messagingme.app/developers/api/catalogs, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/catalogs.md -->

# Catalogs

What a send (POST /v1/sends) can deliver. Every listed template and RCS message is sendable; a scenario says so through opening.

On this page

|   |   |
| --- | --- |
| GET | [/v1/templates](https://console.messagingme.app/developers/api/catalogs.en.md#templates) : Lists the approved, sendable WhatsApp templates. |
| GET | [/v1/scenarios](https://console.messagingme.app/developers/api/catalogs.en.md#scenarios) : Lists the published scenarios and their opening message. |
| GET | [/v1/rcs-messages](https://console.messagingme.app/developers/api/catalogs.en.md#messages-rcs) : Lists the RCS messages of the library. |

<a id="templates"></a>

## GET /v1/templates

Lists the approved, sendable WhatsApp templates.

Scope: `sends:create`

_Command_

```
curl https://api.messagingme.app/v1/templates \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### 200 response

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

| Field | Meaning |
| --- | --- |
| `variables` | One entry per body variable, hence per entry expected in params. source: the field associated in the console, to copy as is into params; null otherwise. |
| `header` | Header type. Carousel: none (visuals per card). |

Left out, because a send or Meta would refuse them:

- category other than marketing or utility;
- location header, or text header with a variable;
- link button with a variable in its URL (except the console’s click-tracking links);
- carousel whose card or link carries a variable;
- header or card visual the console cannot read back.

> **Note**
>
> Live read at Meta: an outage returns an error, never an empty list. [Errors](https://console.messagingme.app/developers/api/reference.en.md#erreurs)

<a id="scenarios"></a>

## GET /v1/scenarios

Lists the published scenarios and their opening message.

Scope: `sends:create`

_Command_

```
curl https://api.messagingme.app/v1/scenarios \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### 200 response

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

| Field | Meaning |
| --- | --- |
| `opening` | Same rule as POST /v1/sends. rcs or whatsapp_template: scenario target (code or name). whatsapp_session: node target on entryNode. null: neither; another block of the scenario, as a node target, is judged on its own. [Opening message](https://console.messagingme.app/developers/api/sends.en.md#ouverture) |
| `openingTemplate` | whatsapp_template opening: the template that params parameterizes; null otherwise. Its variables: GET /v1/templates, same name and language. Other count in params: 422 `unsendable_target`. |
| `entryNode` | nod_ code of the entry block, for a node target: same opening as the scenario. Only path for a whatsapp_session opening. null if the block has no public code. |
| `publishedAt` | null for a scenario published before this date was recorded. |

<a id="messages-rcs"></a>

## GET /v1/rcs-messages

Lists the RCS messages of the library.

Scope: `sends:create`

_Command_

```
curl https://api.messagingme.app/v1/rcs-messages \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### 200 response

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

| Field | Meaning |
| --- | --- |
| `name` | Value of the rcsMessage target. |
| `kind` | `text`, `card` or `carousel`. |
| `variables` | Names between double braces used by the message. |
