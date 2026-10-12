<!-- Version Markdown de https://console.messagingme.app/developers/api/templates, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/templates.en.md -->

# Modèles

Créer un modèle WhatsApp et suivre sa validation par Meta, avec le droit templates:write. Une fois approuvé, il part par [Envois](https://console.messagingme.app/developers/api/sends.md).

Sur cette page

|   |   |
| --- | --- |
| POST | [/v1/templates](https://console.messagingme.app/developers/api/templates.md#creer) : Crée un modèle au format de Meta et le soumet à sa validation. |
| GET | [/v1/templates/{name}](https://console.messagingme.app/developers/api/templates.md#statut) : Lit le statut d’un modèle chez Meta, langue par langue. |

<a id="creer"></a>

## POST /v1/templates

Crée un modèle au format de Meta et le soumet à sa validation.

Droit : `templates:write`

Le corps de Meta (Cloud API, modèles de message) : name, language, category, components. Il passe par la création de l’écran Modèles : ses liens sont tracés et ses gardes s’appliquent.

| Champ | Sens |
| --- | --- |
| `name` | Minuscules, chiffres et _, comme chez Meta. |
| `category` | UTILITY ou MARKETING. Meta peut reclasser : la réponse dit la sienne. |
| `HEADER` | format TEXT avec text, sans variable ; ou IMAGE, VIDEO, DOCUMENT avec example.header_url : l’adresse https du fichier. |
| `BODY` | Obligatoire. Variables {{1}}, {{2}}… contiguës, une valeur d’exemple chacune dans example.body_text. |
| `FOOTER` | Texte court, sans variable. |
| `BUTTONS` | QUICK_REPLY, ou URL (2 au plus) : l’adresse est tracée par nous, sans {{1}}. |

_Commande_

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

### Réponse 201

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

### Erreurs

Dans l’ordre où elles sont vérifiées :

| Statut | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | Corps hors du format, avec le champ fautif ; puis un champ {cle} inconnu dans l’adresse d’un bouton. |
| 409 | `no_whatsapp_number` | Espace sans compte WhatsApp. |
| 429 | `rate_limited` | Toutes les places de dépôt d’en-tête sont prises, ou Meta est momentanément indisponible : réessayez après Retry-After. |
| 422 | `invalid_header_media` | Fichier d’en-tête introuvable, trop lourd, ou d’un autre type. |
| 422 | `template_rejected` | Un lien n’a pas pu être tracé. |
| 409 | `meta_auth_failed` | Meta refuse le jeton de l’espace : reconnectez le compte WhatsApp. |
| 422 | `meta_rejected` | Meta refuse le modèle (nom déjà pris dans cette langue, contenu) : son motif suit. |

### Notes

- Bornes de Meta : corps 1 024 caractères, en-tête et pied 60, texte de bouton 25, 10 boutons.
- Fichier d’en-tête : image JPEG ou PNG jusqu’à 5 Mo, vidéo MP4 ou document PDF jusqu’à 16 Mo. L’adresse ne doit pas rediriger.
- Hors de cette route : carrousel, authentification, Flow, variables nommées.

> **Attention**
>
> Pas d’idempotence : rejouer l’appel avec le même nom est refusé par Meta.

<a id="statut"></a>

## GET /v1/templates/{name}

Lit le statut d’un modèle chez Meta, langue par langue.

Droit : `templates:write`

Le statut de chaque langue chez Meta : pending, approved, rejected, paused… La validation prend de quelques minutes à quelques heures.

_Commande_

```
curl https://api.messagingme.app/v1/templates/commande_prete?language=fr \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### Réponse 200

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

- language (facultatif) : une seule langue. Absent : toutes.
- rejectedReason : le motif de Meta pour un refus, null sinon.

### Erreurs

| Statut | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | Langue hors de la liste WhatsApp. |
| 409 | `no_whatsapp_number` | Espace sans compte WhatsApp. |
| 404 | `template_not_found` | Aucun modèle de ce nom, ou pas dans cette langue. |
