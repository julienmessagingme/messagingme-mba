<!-- Version Markdown de https://console.messagingme.app/developers/api/guides/per-contact, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/guides/per-contact.en.md -->

# Brancher un outil qui appelle par contact

Pour un outil (orchestration, CRM, marketing) qui appelle une fois par contact, avec un corps rempli par le profil. Six étapes ; les étapes 3 à 5 se règlent une fois.

## 1 L’adresse et l’en-tête

_Adresse_

```
POST https://api.messagingme.app/v1/sends
```

En-tête identique pour tous les contacts ; clé avec le droit sends:create :

_En-tête_

```
Authorization: Bearer mba_xxxxxxxxxxxxxxxx
```

## 2 Le corps

Un destinataire par appel : externalId et numéro. L’externalId reste sur la fiche et la retrouve aux appels suivants.

_Corps_

```
{
  "idempotencyKey": "relance-panier-crm-7781-etape-3-2026-09-24",
  "target": {
    "template": {
      "name": "relance_panier",
      "language": "fr"
    }
  },
  "recipients": [
    {
      "externalId": "crm-7781",
      "phone": "+33612345678",
      "consent": "opted_in",
      "consentSource": "outil-marketing",
      "variables": {
        "produit": "Veste en lin"
      }
    }
  ],
  "params": [
    {
      "position": 1,
      "source": {
        "type": "variable",
        "key": "produit"
      }
    }
  ]
}
```

<a id="cle"></a>

## 3 La clé d’idempotence

Dans le corps (idempotencyKey), rempli contact par contact. Composition : identifiant du contact, plus ce qui rend ce passage unique (étape, date d’entrée dans le parcours).

> **Attention**
>
> Clé faite du seul identifiant du contact : un second passage légitime est pris pour un rejeu, et ne part pas.

[Idempotence](https://console.messagingme.app/developers/api/concepts.md#idempotence)

## 4 Le consentement

consent et consentSource à chaque appel, depuis l’outil qui tient le consentement. [Consentement et STOP](https://console.messagingme.app/developers/api/concepts.md#consentement).

## 5 Les variables

variables : les valeurs propres à ce contact (numéro de commande, produit). Rien n’est écrit sur la fiche.

## 6 Éprouver l’appel

Un refus se lit dans la réponse 201 (destinataire écarté) ou dans le code d’erreur (cible introuvable). Outil qui ne lit pas les réponses : un appel à la main d’abord.

_Commande_

```
curl -X POST https://api.messagingme.app/v1/sends \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "idempotencyKey": "relance-panier-crm-7781-etape-3-2026-09-24",
  "target": {
    "template": {
      "name": "relance_panier",
      "language": "fr"
    }
  },
  "recipients": [
    {
      "externalId": "crm-7781",
      "phone": "+33612345678",
      "consent": "opted_in",
      "consentSource": "outil-marketing",
      "variables": {
        "produit": "Veste en lin"
      }
    }
  ],
  "params": [
    {
      "position": 1,
      "source": {
        "type": "variable",
        "key": "produit"
      }
    }
  ]
}'
```

[POST /v1/sends](https://console.messagingme.app/developers/api/sends.md#envoi) · [Erreurs](https://console.messagingme.app/developers/api/reference.md#erreurs)
