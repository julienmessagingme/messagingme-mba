<!-- Markdown version of https://console.messagingme.app/developers/api/templates, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/templates.md -->

# Templates

Create a WhatsApp template and follow its review by Meta, with the templates:write right. Once approved, it goes out through [Sends](https://console.messagingme.app/developers/api/sends.en.md).

On this page

|   |   |
| --- | --- |
| POST | [/v1/templates](https://console.messagingme.app/developers/api/templates.en.md#creer) : Creates a template in Meta’s format and submits it for review. |
| GET | [/v1/templates/{name}](https://console.messagingme.app/developers/api/templates.en.md#statut) : Reads a template’s status at Meta, language by language. |

<a id="creer"></a>

## POST /v1/templates

Creates a template in Meta’s format and submits it for review.

Scope: `templates:write`

Meta’s body (Cloud API, message templates): name, language, category, components. It goes through the Templates screen’s creation: its links are tracked and its checks apply.

| Field | Meaning |
| --- | --- |
| `name` | Lowercase letters, digits and _, as at Meta. |
| `category` | UTILITY or MARKETING. Meta may reclassify: the response gives its own. |
| `HEADER` | format TEXT with text, no variable; or IMAGE, VIDEO, DOCUMENT with example.header_url: the file’s https address. |
| `BODY` | Required. Variables {{1}}, {{2}}… in sequence, one sample value each in example.body_text. |
| `FOOTER` | Short text, no variable. |
| `BUTTONS` | QUICK_REPLY, or URL (2 at most): the address is tracked by us, without {{1}}. |

_Command_

```
curl -X POST https://api.messagingme.app/v1/templates \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "commande_prete",
  "language": "fr",
  "category": "UTILITY",
  "components": [
    {
      "type": "HEADER",
      "format": "IMAGE",
      "example": {
        "header_url": [
          "https://www.exemple.fr/img/commande.jpg"
        ]
      }
    },
    {
      "type": "BODY",
      "text": "Bonjour {{1}}, votre commande est prête. Vous pouvez passer la retirer.",
      "example": {
        "body_text": [
          [
            "Claire"
          ]
        ]
      }
    },
    {
      "type": "FOOTER",
      "text": "Boutique du centre"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "QUICK_REPLY",
          "text": "J’arrive"
        },
        {
          "type": "URL",
          "text": "Voir la commande",
          "url": "https://www.exemple.fr/commandes"
        }
      ]
    }
  ]
}'
```

### 201 response

_JSON_

```
{
  "id": "1489201163476524",
  "name": "commande_prete",
  "language": "fr",
  "category": "utility",
  "status": "pending"
}
```

### Errors

In the order they are checked:

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | Body outside the format, naming the field; then an unknown {key} field in a button URL. |
| 409 | `no_whatsapp_number` | Workspace without a WhatsApp account. |
| 429 | `rate_limited` | All header upload slots are taken, or Meta is briefly unavailable: retry after Retry-After. |
| 422 | `invalid_header_media` | Header file not found, too large, or of another type. |
| 422 | `template_rejected` | A link could not be tracked. |
| 409 | `meta_auth_failed` | Meta refuses the workspace token: reconnect the WhatsApp account. |
| 422 | `meta_rejected` | Meta refuses the template (name already taken in this language, content): its reason follows. |

### Notes

- Meta’s bounds: body 1,024 characters, header and footer 60, button text 25, 10 buttons.
- Header file: JPEG or PNG image up to 5 MB, MP4 video or PDF document up to 16 MB. The address must not redirect.
- Not on this route: carousel, authentication, Flow, named variables.

> **Caution**
>
> No idempotency: replaying the call with the same name is refused by Meta.

<a id="statut"></a>

## GET /v1/templates/{name}

Reads a template’s status at Meta, language by language.

Scope: `templates:write`

Each language’s status at Meta: pending, approved, rejected, paused… Review takes a few minutes to a few hours.

_Command_

```
curl https://api.messagingme.app/v1/templates/commande_prete?language=fr \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### 200 response

_JSON_

```
{
  "name": "commande_prete",
  "languages": [
    {
      "language": "fr",
      "status": "approved",
      "category": "utility",
      "rejectedReason": null
    },
    {
      "language": "en_US",
      "status": "rejected",
      "category": "utility",
      "rejectedReason": "INVALID_FORMAT"
    }
  ]
}
```

- language (optional): a single language. Absent: all.
- rejectedReason: Meta’s reason for a rejection, null otherwise.

### Errors

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | Language outside the WhatsApp list. |
| 409 | `no_whatsapp_number` | Workspace without a WhatsApp account. |
| 404 | `template_not_found` | No template with this name, or not in this language. |
