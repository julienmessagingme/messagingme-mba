# @messagingme/sdk

Le client TypeScript de l'API Messaging Me : des appels typés par chemin et par méthode, des erreurs typées, et la
vérification de signature des webhooks. Aucune dépendance. Node 20 ou plus, Deno, Bun, Workers. Paquet ESM seulement
(`import`, pas `require`).

Ses types sont générés depuis le contrat OpenAPI de l'API (`https://api.messagingme.app/openapi.json`, recopié dans
`openapi.json`) : un chemin, un corps ou une réponse qui n'existent pas ne compilent pas.

Documentation de l'API : https://console.messagingme.app/developers/api

## Installation

```bash
npm install github:julienmessagingme/messagingme-sdk#v0.3.1
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

// Lire une fiche : les paramètres de chemin passent par path.
const fiche = await api.GET('/v1/contacts/{contactId}', { path: { contactId } });

// Les conversations qui attendent une réponse, par pages : query.
const page = await api.GET('/v1/conversations', { query: { needsReply: true, limit: 20 } });

// Un envoi, rejouable sans doublon avec la même clé d’idempotence. Ici un modèle sans variable :
// avec variables, ajoutez params (voir Envois).
const envoi = await api.POST('/v1/sends', {
  body: {
    target: { template: { name: 'bienvenue', language: 'fr' } },
    recipients: [{ phone: '+33612345678' }],
  },
  idempotencyKey: 'commande-7781',
});
```

## Les erreurs

Toute réponse hors 2xx lève `ApiError`, avec le statut, le code de l'API et, quand l'API le dit, le délai à attendre.
Le SDK ne relance rien de lui-même.

Un message WhatsApp ou RCS accepté peut répondre `journal: 'unrecorded'` avec son `messageId` : il est parti chez
le fournisseur, mais son inscription dans l'Inbox n'a pas pu être confirmée. Ne le renvoyez pas.

```ts
import { ApiError } from '@messagingme/sdk';

try {
  await api.POST('/v1/messages/whatsapp', { body: { contactId, text: 'Bonjour' } });
} catch (e) {
  if (e instanceof ApiError) {
    if (e.code === 'window_closed') { /* la personne n’a pas écrit depuis 24 h : passer par un modèle */ }
    if (e.code === 'meta_rejected') { /* Meta a refusé : e.metaCode dit pourquoi (131047, 132000…) */ }
    if (e.status === 429 && e.retryAfter !== null) { /* attendre e.retryAfter secondes */ }
  }
  throw e;
}
```

`code` est posé sur toute réponse d'erreur de l'API (catalogue : https://console.messagingme.app/developers/api/errors).
Il vaut `null` seulement quand une page d'erreur générique a remplacé la réponse en chemin (un 5xx) : pour décider
d'un réessai, regardez `status >= 500`, `internal_error` ou `rate_limited`, jamais `code === null`. `metaCode` porte
le numéro d'erreur de Meta sur `meta_rejected`. `upgradeUrl` est posé sur un 402.

## Vérifier un webhook

Passez le corps BRUT, tel que reçu : la signature porte sur ses octets.

```ts
import { verifyWebhook, WebhookVerificationError } from '@messagingme/sdk';

// Une route qui reçoit les webhooks sortants (ici avec l’API Request standard).
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
horodatage à plus de 5 minutes est refusé (`toleranceSeconds` pour changer). Un même événement peut arriver deux fois
(réessai, rejeu) : dédoublonnez par `event.id`, égal à l'en-tête `webhook-id`. Un secret vide ou illisible lève une
`TypeError` : c'est une erreur de configuration, pas une signature fausse.

## Versions

- **0.3.1** : les réponses des envois WhatsApp et RCS indiquent `journal` (`recorded` ou `unrecorded`).
- **0.3.0** : les types de l'événement `agent.action`, envoyé quand un agent IA déclenche une de vos actions
  pendant une conversation (son identifiant, son nom et les champs recueillis, par code).
- **0.2.0** : `ApiError.metaCode`, le numéro d'erreur de Meta sur `meta_rejected`. L'API pose désormais un `code` sur
  toute réponse d'erreur JSON : `code === null` ne veut plus dire « panne », il ne reste qu'une page d'erreur générique
  remplaçant un 5xx en chemin. Pour réessayer, regardez `status >= 500`, `internal_error` ou `rate_limited`.
- **0.1.0** : première version.

## Licence

MIT.
