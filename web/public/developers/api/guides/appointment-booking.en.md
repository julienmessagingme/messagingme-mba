<!-- Markdown version of https://console.messagingme.app/developers/api/guides/appointment-booking, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/guides/appointment-booking.md -->

# Recipe: appointment booking

A customer asks for an appointment on WhatsApp. The AI agent notes the reason and the city, your app offers three free slots from your calendar, then books the one they pick and confirms it on WhatsApp.

<a id="prompt"></a>

## The prompt to paste

In Claude Code, opened on your project, with the Messaging Me MCP server connected. It points the assistant to this recipe: it has nothing to guess.

_Prompt_

```
Add WhatsApp appointment booking to this project, following the recipe
https://console.messagingme.app/developers/api/guides/appointment-booking.en.md:
1. install the SDK: npm install github:julienmessagingme/messagingme-sdk#v0.3.1;
2. with the Messaging Me tools, turn the agent on, set it as responder, and add it the two actions
   “Appointment request” (fields reason and city, to trigger once the city is known) and “Slot choice” (field slot);
3. write lib/calendar.ts wired to our calendar (offer three free slots, book the one chosen) and the route
   app/api/webhooks/messagingme/route.ts, keeping the same action names and field codes everywhere;
4. subscribe the route to agent.action, unchecked by default, and keep the key and the secret in environment
   variables, never in the code.
Do not invent any route or field: they are in https://api.messagingme.app/openapi.json.
```

<a id="actions"></a>

## The two AI agent actions

On the agent that answers, add two actions with `set_agent_action`: “Appointment request”, with two text fields coded reason and city (instruction: trigger it once the city is known, and say you are checking the free slots), and “Slot choice”, with a text field coded slot (say you are holding the slot). Your app receives agent.action, at most once a day per contact and per action, with the fields known at that moment. The agent must be on (activate_agent) and answer for the workspace (set_default_responder): otherwise no action fires, with no error.

> **Required**
>
> The code reads action.name and fields by their exact name: keep the same action names and field codes in the agent and in the route. And slot is what the agent understood from the customer: your calendar matches it against the slots offered, and books only a slot still free, since two customers can pick the same. Otherwise, answer with other slots and a link to book: a second “Slot choice” the same day would not reach your app.

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

What the case needs from your calendar: wire these two functions to your database.

_lib/calendar.ts_

```
// What this case needs from your calendar: Claude Code wires these functions to your own database.
const todo = (what: string): never => { throw new Error(`lib/calendar.ts: ${what} is not connected yet`); };

/** A few free slots near this city, written as the WhatsApp message that offers them. */
export async function offerSlots(city: string, count: number): Promise<string> { return todo('offerSlots'); }
/**
 * Books the chosen slot once per request (the same event twice books once) and returns the confirmation. `slot` is
 * the AI agent’s reading of the customer’s words: match it against the slots offered, book only one still free (two
 * customers can pick the same). Otherwise return other free slots and a link to book: a second Slot choice the same
 * day does not reach your app.
 */
export async function book(requestId: string, slot: string): Promise<string> { return todo('book'); }
```

<a id="webhook"></a>

## The route that receives the actions

Declare its address with `create_webhook_endpoint` or with [POST /v1/webhooks](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#creer), with the type agent.action: it is unticked by default. The route answers the customer with [POST /v1/messages/whatsapp](https://console.messagingme.app/developers/api/messages.en.md#message-whatsapp): they just wrote, the 24-hour window is open.

_app/api/webhooks/messagingme/route.ts_

```
import { verifyWebhook, WebhookVerificationError } from '@messagingme/sdk';
import { messagingme } from '../../../../lib/messagingme';
import { book, offerSlots } from '../../../../lib/calendar';

// Subscribed to agent.action: the AI agent’s two actions, Appointment request (fields reason and city) and Slot
// choice (field slot). The type is unchecked by default on a webhook address. An action fires once a day per
// customer, with the fields known at that moment: its instruction tells the agent to wait for the city.
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
  if (event.type !== 'agent.action' || !event.data.contact) return new Response(null, { status: 204 });
  const { action, fields, contact } = event.data;
  let text: string | null = null;
  if (action.name === 'Appointment request') text = await offerSlots(String(fields.city ?? ''), 3);
  if (action.name === 'Slot choice' && fields.slot !== undefined) text = await book(event.id, String(fields.slot));
  if (text) await messagingme.POST('/v1/messages/whatsapp', { body: { contactId: contact.id, text } });
  // The webhook waits 10 s for this answer, then retries the same event (same event.id): keep the work above
  // short, and your calendar functions safe to run twice.
  return new Response(null, { status: 204 });
}
```

<a id="essayer"></a>

## Trying it

- Send a test event with `send_test_event` or with [POST /v1/webhooks/{webhookId}/test](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#essai): the route must answer 2xx.
- From your phone, write to the workspace number that you want an appointment, give a city, then pick one of the slots offered.
