<!-- Markdown version of https://console.messagingme.app/developers/api/guides/order-notifications, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/guides/order-notifications.md -->

# Recipe: order notifications

When an order moves to shipped, your app sends the customer a WhatsApp message with their tracking link. Meta’s receipts come back to your route: the order shows delivered, then read. If the customer replies, the conversation goes to the AI agent.

<a id="prompt"></a>

## The prompt to paste

In Claude Code, opened on your project, with the Messaging Me MCP server connected. It points the assistant to this recipe: it has nothing to guess.

_Prompt_

```
Add WhatsApp order notifications to this project, following the recipe
https://console.messagingme.app/developers/api/guides/order-notifications.en.md:
1. install the SDK: npm install github:julienmessagingme/messagingme-sdk#v0.3.1;
2. with the Messaging Me tools, create the shipping template (UTILITY, the first name then the order number, a
   URL button to our tracking page);
3. write lib/orders.ts wired to our orders (the send when an order moves to shipped) and the route
   app/api/webhooks/messagingme/route.ts that marks the order delivered then read;
4. subscribe the route to message.delivered and message.read, unchecked by default, and keep the key and the
   secret in environment variables, never in the code.
Do not invent any route or field: they are in https://api.messagingme.app/openapi.json.
```

<a id="modele"></a>

## The shipping template

A UTILITY template with two variables (the first name, then the order number) and a URL button to your tracking page. Create it with `create_template` (MCP server) or with [POST /v1/templates](https://console.messagingme.app/developers/api/templates.en.md#creer), then wait for Meta’s approval, often within minutes; `get_template_status` confirms it.

> **Required**
>
> The button’s address is fixed: it leads to your tracking page, and the order number travels in the message body.

<a id="code"></a>

## The code

Install the SDK, then the variables in `.env.local` and in your host’s.

_Command_

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

The send, called when an order moves to shipped. It goes through [POST /v1/sends](https://console.messagingme.app/developers/api/sends.en.md#envoi), with an idempotency key taken from the order: replayed within 24 hours, it does not send twice. The send identifier it returns is stored on the order: the receipts carry it.

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

## The route that receives the receipts

Declare its address with `create_webhook_endpoint` or with [POST /v1/webhooks](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#creer), with the types message.delivered and message.read: they are unticked by default.

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

> **Required**
>
> A customer who turned off read receipts in WhatsApp never sends message.read: their order stays delivered.

<a id="reponse"></a>

## If the customer replies

Their reply opens a conversation. The AI agent that answers for the workspace (`set_default_responder`) takes it, with your delivery policy in its knowledge (`add_knowledge`); on Pro, your team can take over in the console’s Inbox. The route has nothing to do.

<a id="essayer"></a>

## Trying it

- Send a test event with `send_test_event` or with [POST /v1/webhooks/{webhookId}/test](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#essai): the route must answer 2xx.
- Place an order with your own number, mark it shipped, open the message on your phone: the order shows delivered, then read.
