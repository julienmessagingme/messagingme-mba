<!-- Version Markdown de https://console.messagingme.app/developers/api/guides/nextjs, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/guides/nextjs.en.md -->

# Recette : Next.js

Un projet Next.js (App Router) qui envoie un modèle WhatsApp et reçoit les webhooks sortants, signature vérifiée. Collez le prompt dans votre assistant de code, ou recopiez les trois fichiers.

<a id="prompt"></a>

## Le prompt à coller

Dans Claude Code, Cursor ou un autre assistant, ouvert sur votre projet. Il renvoie l’assistant vers cette recette et vers le contrat de l’API : il n’a rien à deviner.

_Prompt_

```
Branche Messaging Me (WhatsApp) dans ce projet Next.js (App Router), en suivant la recette
https://console.messagingme.app/developers/api/guides/nextjs.md :
1. installe le SDK : npm install github:julienmessagingme/messagingme-sdk#v0.3.1 ;
2. crée lib/messagingme.ts (le client, côté serveur seulement) ;
3. crée la route POST /api/confirmation qui envoie le modèle « confirmation_commande » (deux variables : le nom
   du contact, puis le numéro de commande) avec une clé d’idempotence tirée du numéro de commande, et renvoie
   e.code et e.metaCode en cas d’erreur ;
4. crée la route POST /api/webhooks/messagingme qui vérifie la signature avec verifyWebhook sur le corps brut
   et répond 204 ;
5. ajoute MESSAGINGME_API_KEY et MESSAGINGME_WEBHOOK_SECRET à .env.local, sans valeur réelle dans le code.
N’invente aucune route ni aucun champ : ils sont dans https://api.messagingme.app/openapi.json.
```

<a id="installation"></a>

## Installation

_Commande_

```
npm install github:julienmessagingme/messagingme-sdk#v0.3.1
```

Deux variables dans `.env.local` : la clé d’API (Developers > Clés d’API, droit sends:create) et le secret de l’adresse de webhook, donné une seule fois à sa création.

_.env.local_

```
MESSAGINGME_API_KEY=mba_...
MESSAGINGME_WEBHOOK_SECRET=whsec_...
```

<a id="client"></a>

## Le client

_lib/messagingme.ts_

```
import { createClient } from '@messagingme/sdk';

// Côté serveur seulement : la clé ne doit jamais partir dans le navigateur (pas de NEXT_PUBLIC_).
export const messagingme = createClient({ apiKey: process.env.MESSAGINGME_API_KEY! });
```

<a id="envoi"></a>

## Envoyer un modèle

Le modèle doit être approuvé par Meta ([GET /v1/templates/{name}](https://console.messagingme.app/developers/api/templates.md#statut)). La clé d’idempotence tirée du numéro de commande empêche un doublon pendant 24 h, même si la route est rappelée.

_app/api/confirmation/route.ts_

```
import { ApiError } from '@messagingme/sdk';
import { messagingme } from '../../../lib/messagingme';

// POST /api/confirmation, avec phone (au format +33…) et commande dans le corps JSON.
export async function POST(req: Request) {
  const { phone, commande } = (await req.json()) as { phone?: unknown; commande?: unknown };
  if (typeof phone !== 'string' || typeof commande !== 'string') {
    return Response.json({ error: 'phone et commande requis' }, { status: 400 });
  }
  try {
    const envoi = await messagingme.POST('/v1/sends', {
      body: {
        // Le modèle a deux variables : le nom du contact, puis le numéro de commande.
        target: { template: { name: 'confirmation_commande', language: 'fr' } },
        recipients: [{ phone, variables: { commande } }],
        params: [
          { position: 1, source: { type: 'attribute', key: 'name' }, fallback: 'Bonjour' },
          { position: 2, source: { type: 'variable', key: 'commande' } },
        ],
      },
      // Rappelée avec la même commande pendant 24 h, la route ne renvoie pas le message.
      idempotencyKey: `commande-${commande}`,
    });
    return Response.json({ sendId: envoi.sendId, skipped: envoi.skipped });
  } catch (e) {
    if (e instanceof ApiError) {
      // e.code est stable (voir le catalogue des erreurs) ; e.metaCode porte le numéro de Meta sur meta_rejected.
      return Response.json({ code: e.code, metaCode: e.metaCode, error: e.message }, { status: e.status });
    }
    throw e;
  }
}
```

- Un destinataire désabonné ou sans consentement n’est pas une erreur : il revient dans `skipped`, avec son motif.
- Une erreur porte `code` (le catalogue : [codes de l’API](https://console.messagingme.app/developers/api/errors.md#codes)) et, sur [`meta_rejected`](https://console.messagingme.app/developers/api/errors.md#meta_rejected), le numéro de Meta : `e.metaCode`.

<a id="webhook"></a>

## Recevoir les webhooks

Déclarez l’adresse `https://votre-domaine/api/webhooks/messagingme` dans la console (Developers > Webhooks sortants) ou par [POST /v1/webhooks](https://console.messagingme.app/developers/api/webhook-endpoints.md#creer), et cochez message.failed : il est décoché par défaut.

_app/api/webhooks/messagingme/route.ts_

```
import { verifyWebhook, WebhookVerificationError } from '@messagingme/sdk';

export async function POST(req: Request) {
  // Le corps BRUT : la signature porte sur ses octets.
  const body = await req.text();
  let event;
  try {
    event = await verifyWebhook({ secret: process.env.MESSAGINGME_WEBHOOK_SECRET!, headers: req.headers, body });
  } catch (e) {
    if (e instanceof WebhookVerificationError) return new Response(null, { status: 401 });
    throw e;
  }
  // Un même événement peut arriver deux fois : dédoublonnez par event.id.
  if (event.type === 'message.received') console.log('reçu', event.data.contact, event.data.text);
  if (event.type === 'message.failed') console.warn('échec', event.data.meta_code, event.data.reason);
  // Répondre vite (moins de 10 s) : un traitement long se fait après, sinon le webhook est réessayé.
  return new Response(null, { status: 204 });
}
```

> **Obligatoire**
>
> Lisez le corps BRUT (req.text()), jamais req.json() avant la vérification : la signature porte sur les octets reçus. Répondez en moins de 10 s, sinon l’envoi est réessayé.

<a id="essayer"></a>

## Essayer

- Envoyez un événement d’essai depuis la console, ou par [POST /v1/webhooks/{webhookId}/test](https://console.messagingme.app/developers/api/webhook-endpoints.md#essai) : la route doit répondre 204.
- Appelez POST /api/confirmation avec votre propre numéro : le modèle arrive sur votre téléphone.
- Répondez depuis votre téléphone : la route reçoit message.received.
