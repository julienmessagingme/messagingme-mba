<!-- Markdown version of https://console.messagingme.app/developers/api/guides/failed-payment-recovery, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/guides/failed-payment-recovery.md -->

# Recipe: failed payment recovery

When Stripe reports a failed payment, your app sends the user a WhatsApp message with the link to their billing page, so they update their card before losing access.

<a id="prompt"></a>

## The prompt to paste

In Claude Code, opened on your project, with the Messaging Me MCP server connected. It points the assistant to this recipe: it has nothing to guess.

_Prompt_

```
Add WhatsApp recovery of failed payments to this project, following the recipe
https://console.messagingme.app/developers/api/guides/failed-payment-recovery.en.md:
1. install the SDK: npm install github:julienmessagingme/messagingme-sdk#v0.3.1;
2. with the Messaging Me tools, create the failed payment template (UTILITY, the first name, a URL button to our
   billing page);
3. write lib/billing.ts wired to Stripe (signature checked) and to our users, and wire the send into our Stripe
   webhook app/api/stripe/route.ts, on invoice.payment_failed, with one idempotency key per invoice;
4. keep the keys and secrets in environment variables, never in the code.
Do not invent any route or field: they are in https://api.messagingme.app/openapi.json.
```

<a id="modele"></a>

## The failed payment template

A UTILITY template with one variable (the first name) and a URL button to your billing page: an alert on the user’s account. Create it with `create_template` (MCP server) or with [POST /v1/templates](https://console.messagingme.app/developers/api/templates.en.md#creer), then wait for Meta’s approval; `get_template_status` confirms it.

> **Required**
>
> Keep the text factual: the payment, the card, the access. A template Meta reclassifies as marketing then only goes to contacts who consented.

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

What the case needs from your billing: wire these two functions to Stripe and to your users.

_lib/billing.ts_

```
// What this case needs from your billing: Claude Code wires these two functions to Stripe and to your users.
const todo = (what: string): never => { throw new Error(`lib/billing.ts: ${what} is not connected yet`); };

export interface StripeInvoiceEvent { id: string; type: string; data: { object: { id: string; customer: string } } }

/** Stripe’s event with its signature checked (stripe.webhooks.constructEvent and your signing secret); null if invalid. */
export async function verifiedStripeEvent(req: Request): Promise<StripeInvoiceEvent | null> { return todo('verifiedStripeEvent'); }
/** The user behind a Stripe customer, if there is one. */
export async function userOfCustomer(customerId: string): Promise<{ phone: string; firstName: string } | null> { return todo('userOfCustomer'); }
```

<a id="stripe"></a>

## The Stripe webhook

In the Stripe webhook your app already has, on invoice.payment_failed. The send goes through [POST /v1/sends](https://console.messagingme.app/developers/api/sends.en.md#envoi), with an idempotency key taken from the invoice: the same event delivered twice within 24 hours sends one message. No Messaging Me webhook address is needed.

_app/api/stripe/route.ts_

```
import { messagingme } from '../../../lib/messagingme';
import { userOfCustomer, verifiedStripeEvent } from '../../../lib/billing';

// Your Stripe webhook, the one you already have. The template payment_failed is UTILITY (an account alert): one
// variable, the first name, and a URL button to your billing page.
export async function POST(req: Request) {
  const event = await verifiedStripeEvent(req);
  if (!event) return new Response(null, { status: 400 });
  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const user = await userOfCustomer(invoice.customer);
    if (user) {
      await messagingme.POST('/v1/sends', {
        body: {
          target: { template: { name: 'payment_failed', language: 'en' } },
          recipients: [{ phone: user.phone, variables: { firstName: user.firstName } }],
          params: [{ position: 1, source: { type: 'variable', key: 'firstName' } }],
        },
        // Stripe may deliver the same event again: within 24 hours, one message per invoice.
        idempotencyKey: `payment-${invoice.id}`,
      });
    }
  }
  return new Response(null, { status: 200 });
}
```

<a id="essayer"></a>

## Trying it

- With the Stripe CLI, trigger invoice.payment_failed for a customer tied to your own number: the message arrives, and its button opens your billing page.
- Or send the template with `send_template_to_contact` to your number, before wiring Stripe.
