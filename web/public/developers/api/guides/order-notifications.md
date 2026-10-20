<!-- Version Markdown de https://console.messagingme.app/developers/api/guides/order-notifications, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/guides/order-notifications.en.md -->

# Recette : les notifications de commande

Quand une commande passe en expédiée, votre application envoie au client un message WhatsApp avec son lien de suivi. Les accusés de Meta reviennent sur votre route : la commande s’affiche livrée, puis lue. Si le client répond, la conversation part à l’agent IA.

<a id="prompt"></a>

## Le prompt à coller

Dans Claude Code, ouvert sur votre projet, avec le serveur MCP de Messaging Me branché. Il renvoie l’assistant vers cette recette : il n’a rien à deviner.

_Prompt_

```
Branche les notifications de commande WhatsApp dans ce projet, en suivant la recette
https://console.messagingme.app/developers/api/guides/order-notifications.md :
1. installe le SDK : npm install github:julienmessagingme/messagingme-sdk#v0.3.1 ;
2. avec les outils Messaging Me, crée le modèle d’expédition (UTILITY, le prénom puis le numéro de commande, un
   bouton URL vers notre page de suivi) ;
3. écris lib/orders.ts relié à nos commandes (l’envoi quand une commande passe en expédiée) et la route
   app/api/webhooks/messagingme/route.ts qui marque la commande livrée puis lue ;
4. abonne la route à message.delivered et message.read, décochés par défaut, et range la clé et le secret dans
   les variables d’environnement, jamais dans le code.
N’invente aucune route ni aucun champ : ils sont dans https://api.messagingme.app/openapi.json.
```

<a id="modele"></a>

## Le modèle d’expédition

Un modèle UTILITY à deux variables (le prénom, puis le numéro de commande) et un bouton URL vers votre page de suivi. Créez-le par `create_template` (serveur MCP) ou par [POST /v1/templates](https://console.messagingme.app/developers/api/templates.md#creer), puis attendez l’approbation de Meta, souvent en quelques minutes ; `get_template_status` la confirme.

> **Obligatoire**
>
> L’adresse du bouton est fixe : elle mène à votre page de suivi, et le numéro de commande voyage dans le corps du message.

<a id="code"></a>

## Le code

Installez le SDK, puis les variables dans `.env.local` et dans celles de votre hébergeur.

_Commande_

```
npm install github:julienmessagingme/messagingme-sdk#v0.3.1
```

_.env.local_

```
MESSAGINGME_API_KEY=mba_...
MESSAGINGME_WEBHOOK_SECRET=whsec_...
```

_lib/messagingme.ts_

```
import { createClient } from '@messagingme/sdk';

// Server side only: the key must never reach the browser (no NEXT_PUBLIC_ prefix).
export const messagingme = createClient({ apiKey: process.env.MESSAGINGME_API_KEY! });
```

L’envoi, appelé quand une commande passe en expédiée. Il part par [POST /v1/sends](https://console.messagingme.app/developers/api/sends.md#envoi), avec une clé d’idempotence tirée de la commande : rejoué dans les 24 heures, il n’envoie pas deux fois. L’identifiant d’envoi rendu se range sur la commande, c’est lui que portent les accusés.

_lib/orders.ts_

```
import { messagingme } from './messagingme';

// What this case needs from your orders: Claude Code wires these two functions to your own database.
const todo = (what: string): never => { throw new Error(`lib/orders.ts: ${what} is not connected yet`); };
export async function saveSendId(orderId: string, sendId: string): Promise<void> { return todo('saveSendId'); }
export async function setWhatsappStatus(sendId: string, status: 'delivered' | 'read'): Promise<void> { return todo('setWhatsappStatus'); }

// Call it when an order moves to shipped. The template order_shipped has two variables, the first name then the
// order number, and a URL button to your tracking page.
export async function notifyShipped(order: { id: string; phone: string; firstName: string }): Promise<void> {
  const send = await messagingme.POST('/v1/sends', {
    body: {
      target: { template: { name: 'order_shipped', language: 'en' } },
      recipients: [{ phone: order.phone, variables: { firstName: order.firstName, order: order.id } }],
      params: [
        { position: 1, source: { type: 'variable', key: 'firstName' } },
        { position: 2, source: { type: 'variable', key: 'order' } },
      ],
    },
    // Replayed within 24 hours (the life of the key), the shipment does not send twice.
    idempotencyKey: `shipped-${order.id}`,
  });
  // The delivery and read receipts carry this sendId: it ties them back to the order.
  await saveSendId(order.id, send.sendId);
}
```

<a id="webhook"></a>

## La route qui reçoit les accusés

Déclarez son adresse par `create_webhook_endpoint` ou par [POST /v1/webhooks](https://console.messagingme.app/developers/api/webhook-endpoints.md#creer), avec les types message.delivered et message.read : ils sont décochés par défaut.

_app/api/webhooks/messagingme/route.ts_

```
import { verifyWebhook, WebhookVerificationError } from '@messagingme/sdk';
import { setWhatsappStatus } from '../../../../lib/orders';

// Subscribed to message.delivered and message.read, both unchecked by default on a webhook address.
export async function POST(req: Request) {
  // The RAW body: the signature covers its bytes.
  const body = await req.text();
  let event;
  try {
    event = await verifyWebhook({ secret: process.env.MESSAGINGME_WEBHOOK_SECRET!, headers: req.headers, body });
  } catch (e) {
    if (e instanceof WebhookVerificationError) return new Response(null, { status: 401 });
    throw e;
  }
  if ((event.type === 'message.delivered' || event.type === 'message.read') && event.data.send_id) {
    await setWhatsappStatus(event.data.send_id, event.type === 'message.read' ? 'read' : 'delivered');
  }
  return new Response(null, { status: 204 });
}
```

> **Obligatoire**
>
> Un client qui a désactivé les confirmations de lecture dans WhatsApp n’envoie jamais message.read : sa commande reste livrée.

<a id="reponse"></a>

## Si le client répond

Sa réponse ouvre une conversation. L’agent IA qui répond pour l’espace (`set_default_responder`) la prend, avec votre politique de livraison dans sa connaissance (`add_knowledge`) ; votre équipe peut reprendre la main dans l’Inbox. La route n’a rien à faire.

<a id="essayer"></a>

## Essayer

- Envoyez un événement d’essai par `send_test_event` ou par [POST /v1/webhooks/{webhookId}/test](https://console.messagingme.app/developers/api/webhook-endpoints.md#essai) : la route doit répondre 2xx.
- Passez une commande avec votre propre numéro, marquez-la expédiée, ouvrez le message sur votre téléphone : la commande s’affiche livrée, puis lue.
