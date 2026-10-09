# @messagingme/sdk

Le client TypeScript de l'API Messaging Me : des appels typés par chemin et par méthode, des erreurs typées, et la
vérification de signature des webhooks. Aucune dépendance. Node 18 ou plus, Deno, Bun, Workers.

Ses types sont générés depuis le contrat OpenAPI de l'API (`https://api.messagingme.app/openapi.json`, recopié dans
`openapi.json`) : un chemin, un corps ou une réponse qui n'existent pas ne compilent pas.

Documentation de l'API : https://console.messagingme.app/developers/api

## Installation

```bash
npm install github:julienmessagingme/messagingme-sdk#v0.1.0
```

## Un premier appel

La clé d'API (`mba_…`) se crée dans la console, Developers > Clés d'API. Gardez-la côté serveur.

```ts
import { createClient } from '@messagingme/sdk';

const api = createClient({ apiKey: process.env.MESSAGINGME_API_KEY! });

// Créer une fiche, ou la mettre à jour si elle existe.
const { contactId, status } = await api.POST('/v1/contacts', {
  body: { phone: '+33612345678', name: 'Camille Roy', consent: 'opted_in', consentSource: 'formulaire-site' },
});

// Lire une fiche : les paramètres de chemin passent par `path`.
const fiche = await api.GET('/v1/contacts/{contactId}', { path: { contactId } });

// Les conversations qui attendent une réponse, par pages : `query`.
const page = await api.GET('/v1/conversations', { query: { needsReply: true, limit: 20 } });

// Un envoi, rejouable sans doublon avec la même clé d'idempotence.
const envoi = await api.POST('/v1/sends', {
  body: {
    target: { template: { name: 'confirmation_commande', language: 'fr' } },
    recipients: [{ phone: '+33612345678' }],
  },
  idempotencyKey: 'commande-7781',
});
```

## Les erreurs

Toute réponse hors 2xx lève `ApiError`, avec le statut, le code de l'API et, quand l'API le dit, le délai à attendre.
Le SDK ne relance rien de lui-même.

```ts
import { ApiError } from '@messagingme/sdk';

try {
  await api.POST('/v1/messages/whatsapp', { body: { contactId, text: 'Bonjour' } });
} catch (e) {
  if (e instanceof ApiError) {
    if (e.code === 'window_closed') { /* la personne n'a pas écrit depuis 24 h : passer par un modèle */ }
    if (e.status === 429 && e.retryAfter !== null) { /* attendre e.retryAfter secondes */ }
  }
  throw e;
}
```

`code` vaut `null` sur une panne générique (JSON illisible, erreur interne). `upgradeUrl` est posé sur un 402.

## Vérifier un webhook

Passez le corps BRUT, tel que reçu : la signature porte sur ses octets.

```ts
import { verifyWebhook, WebhookVerificationError } from '@messagingme/sdk';

// Next.js (route handler)
export async function POST(req: Request) {
  const body = await req.text();
  try {
    const event = await verifyWebhook({ secret: process.env.MESSAGINGME_WEBHOOK_SECRET!, headers: req.headers, body });
    if (event.type === 'message.received') console.log(event.data.text);
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof WebhookVerificationError) return new Response(null, { status: 401 });
    throw e;
  }
}
```

Pendant une rotation de secret, l'ancien signe encore 24 h : passez les deux, `secret: [nouveau, ancien]`. Un
horodatage à plus de 5 minutes est refusé (`toleranceSeconds` pour changer).

## Licence

MIT.
