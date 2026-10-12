<!-- Version Markdown de https://console.messagingme.app/developers/api/quickstart, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/quickstart.en.md -->

# Démarrer en dix minutes

De l’inscription au premier message envoyé par l’API, avec votre propre téléphone pour vérifier chaque étape. Il vous faut un numéro WhatsApp (le vôtre, ou un numéro que nous fournissons) et un serveur qui reçoit des requêtes HTTPS.

<a id="espace"></a>

## 1. Créer son espace et brancher son numéro

Inscrivez-vous sur `https://console.messagingme.app/signup`. La console enchaîne : connecter un numéro WhatsApp (le vôtre, par la fenêtre de Meta, ou un numéro fourni), puis une page qui donne la commande pour brancher Claude Code et le premier message à lui écrire.

Sans numéro branché, rien ne part : [`no_whatsapp_number`](https://console.messagingme.app/developers/api/errors.md#no_whatsapp_number).

<a id="cle"></a>

## 2. Créer une clé d’API

Dans la console, Developers > Clés d’API. Cochez au moins sends:create (envoyer) et conversations:read (lire les fils). La clé (mba_…) n’est montrée qu’une fois : gardez-la côté serveur, dans une variable d’environnement.

_Vérifier la clé_

```
curl https://api.messagingme.app/v1/templates \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

Une liste, même vide, veut dire que la clé marche. Sinon : [`unauthorized`](https://console.messagingme.app/developers/api/errors.md#unauthorized), [`missing_scope`](https://console.messagingme.app/developers/api/errors.md#missing_scope).

<a id="webhook"></a>

## 3. Recevoir les événements

Déclarez l’adresse de votre serveur dans la console (Developers > Webhooks sortants), ou par l’API avec une clé qui porte webhooks:write. Le secret (whsec_…) n’est montré qu’une fois : il sert à vérifier chaque signature.

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

Vérifiez la signature sur le corps brut, avec le [SDK](https://console.messagingme.app/developers/api/sdk.md#webhook) ou à la main ([le format](https://console.messagingme.app/developers/api/webhooks.md#signature)), puis répondez 2xx en moins de 10 s.

<a id="premier-envoi"></a>

## 4. Un premier envoi

Le plus rapide : depuis votre téléphone, écrivez au numéro de l’espace. Votre serveur reçoit message.received, avec la fiche créée pour vous. Pendant 24 h, l’API peut vous répondre par un message libre :

_Commande_

```
curl -X POST https://api.messagingme.app/v1/messages/whatsapp \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "phone": "+33612345678",
  "text": "Bien reçu, merci ! Nous revenons vers vous dans la journée."
}'
```

Pour écrire en premier, il faut un modèle approuvé par Meta : créez-le dans la console (Contenu > WhatsApp > Templates) ou par [POST /v1/templates](https://console.messagingme.app/developers/api/templates.md#creer), attendez son approbation (de quelques minutes à 24 h), puis envoyez-le :

_Commande_

```
curl -X POST https://api.messagingme.app/v1/sends \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "idempotencyKey": "premier-envoi-1",
  "target": {
    "template": {
      "name": "confirmation_commande",
      "language": "fr"
    }
  },
  "recipients": [
    {
      "phone": "+33612345678"
    }
  ],
  "params": [
    {
      "position": 1,
      "source": {
        "type": "attribute",
        "key": "name"
      },
      "fallback": "Bonjour"
    },
    {
      "position": 2,
      "source": {
        "type": "literal",
        "value": "8412"
      }
    }
  ]
}'
```

- Fenêtre fermée : [`window_closed`](https://console.messagingme.app/developers/api/errors.md#window_closed) ; passez par un modèle.
- Pas de carte dans le Business Manager : [`131042`](https://console.messagingme.app/developers/api/errors.md#meta-131042).
- Le numéro n’est pas sur WhatsApp : [`131026`](https://console.messagingme.app/developers/api/errors.md#meta-131026).

<a id="ensuite"></a>

## Ensuite

- [Les pièges de Meta](https://console.messagingme.app/developers/api/guides/meta-pitfalls.md) : ce que Meta impose, avant votre premier envoi en nombre.
- [La recette Next.js](https://console.messagingme.app/developers/api/guides/nextjs.md) : les mêmes étapes dans un projet, avec un prompt à coller.
- [Le catalogue des erreurs](https://console.messagingme.app/developers/api/errors.md) : chaque code et quoi faire.

> **Note**
>
> Avec Claude Code, tout ceci se fait aussi en conversation : [le serveur MCP](https://console.messagingme.app/developers/mcp.md).
