<!-- Markdown version of https://console.messagingme.app/developers/api/guides/appointment-reminders, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/guides/appointment-reminders.md -->

# Recipe: appointment reminders

The evening before each appointment, your app sends a WhatsApp reminder with two buttons. Confirm marks the appointment as confirmed; Reschedule hands over to the AI agent, which offers free slots, and your app moves the appointment to the one chosen.

<a id="prompt"></a>

## The prompt to paste

In Claude Code, opened on your project, with the Messaging Me MCP server connected. It points the assistant to this recipe: it has nothing to guess.

_Prompt_

```
Add WhatsApp appointment reminders to this project, following the recipe
https://console.messagingme.app/developers/api/guides/appointment-reminders.en.md:
1. install the SDK: npm install github:julienmessagingme/messagingme-sdk#v0.3.1;
2. with the Messaging Me tools, create the reminder template appointment_reminder (UTILITY, en, the first name then the
   time, two quick reply buttons) and, on the agent that answers (on and set as responder), the two actions
   “Reschedule request” (no field) and “Slot choice” (field slot);
3. write lib/calendar.ts wired to our calendar, jobs/reminders.ts (the day-before job) and the route
   app/api/webhooks/messagingme/route.ts, keeping the same button labels and action names everywhere;
4. subscribe the route to message.received and agent.action, and keep the key and the secret in environment
   variables, never in the code.
Do not invent any route or field: they are in https://api.messagingme.app/openapi.json.
```

<a id="modele"></a>

## The reminder template

A UTILITY template with two variables (the first name, then the time) and two quick reply buttons, 25 characters at most each. Create it with `create_template` (MCP server) or with [POST /v1/templates](https://console.messagingme.app/developers/api/templates.en.md#creer), then wait for Meta’s approval, often within minutes. The code calls it appointment_reminder, in English (en): keep that name and language, or change them in the code.

> **Required**
>
> A tapped button arrives in message.received by its LABEL (data.button), without saying which message it answers. The code compares that label and finds the last reminder sent to the number: keep the same label in the template and in the route.

<a id="actions"></a>

## The two AI agent actions

On the agent that answers, add two actions with `set_agent_action`: “Reschedule request”, with no field (say you are checking the free slots), and “Slot choice”, with a text field coded slot (say you are holding the slot). Your app receives agent.action, at most once a day per contact and per action. The agent must be on (`activate_agent`) and answer for the workspace (`set_default_responder`): otherwise no action fires, with no error.

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

What the case needs from your calendar: wire these functions to your database.

_lib/calendar.ts_

```
// What this case needs from your calendar: Claude Code wires these functions to your own database.
export interface Appointment {
  id: string;
  phone: string; // E.164: +33612345678
  firstName: string;
  time: string; // as the patient reads it: '10:30 AM'
}

const todo = (what: string): never => { throw new Error(`lib/calendar.ts: ${what} is not connected yet`); };

/** Tomorrow's appointments: the ones to remind tonight. */
export async function tomorrowsAppointments(): Promise<Appointment[]> { return todo('tomorrowsAppointments'); }
/** Remembers the reminder sent to this number: a button reply does not say which message it answers. */
export async function saveReminder(appointment: Appointment, sendId: string): Promise<void> { return todo('saveReminder'); }
/** The last reminder sent to this number, or null. */
export async function lastReminder(phone: string): Promise<Appointment | null> { return todo('lastReminder'); }
export async function markConfirmed(appointment: Appointment): Promise<void> { return todo('markConfirmed'); }
/** A few free slots, written as the WhatsApp message that offers them. */
export async function freeSlots(appointment: Appointment, count: number): Promise<string> { return todo('freeSlots'); }
/**
 * Moves the appointment to the chosen slot and returns the confirmation. `slot` is the AI agent’s reading of the
 * customer’s words: match it against the slots offered and move only to one still free. Otherwise answer with
 * other free slots and a link to book: a second Slot choice the same day does not reach your app.
 */
export async function move(appointment: Appointment, slot: string): Promise<string> { return todo('move'); }
```

The day-before job, run every evening by your host’s scheduler. It sends through [POST /v1/sends](https://console.messagingme.app/developers/api/sends.en.md#envoi), with an idempotency key taken from the appointment and its time: run again the same evening, it does not send twice. A recipient set aside (STOP, plan limit) is not an error, it comes back in skipped with its reason; an error on one appointment does not stop the others, an exceeded rate (rate_limited) waits the delay the API gives, and the daily quota reached (quota_exceeded) stops the job until the next day.

_jobs/reminders.ts_

```
import { ApiError } from '@messagingme/sdk';
import { messagingme } from '../lib/messagingme';
import { saveReminder, tomorrowsAppointments, type Appointment } from '../lib/calendar';

// The template appointment_reminder (language en) has two variables, the first name then the time, and two quick
// reply buttons: Confirm and Reschedule.
function sendReminder(appointment: Appointment) {
  return messagingme.POST('/v1/sends', {
    body: {
      target: { template: { name: 'appointment_reminder', language: 'en' } },
      recipients: [{ phone: appointment.phone, variables: { firstName: appointment.firstName, time: appointment.time } }],
      params: [
        { position: 1, source: { type: 'variable', key: 'firstName' } },
        { position: 2, source: { type: 'variable', key: 'time' } },
      ],
    },
    // Run twice the same evening, the job does not send twice; a moved appointment gets a new key.
    idempotencyKey: `reminder-${appointment.id}-${encodeURIComponent(appointment.time)}`,
  });
}

// Run once a day, the evening before (a cron of your host). One failed reminder never stops the others.
export async function dayBeforeReminders(): Promise<void> {
  for (const appointment of await tomorrowsAppointments()) {
    try {
      let send;
      try {
        send = await sendReminder(appointment);
      } catch (e) {
        // Too many calls in the minute: wait what the API says (60 s at most), then try once more.
        if (!(e instanceof ApiError) || e.code !== 'rate_limited') throw e;
        await new Promise((r) => setTimeout(r, Math.min(e.retryAfter ?? 60, 60) * 1000));
        send = await sendReminder(appointment);
      }
      // A refused recipient (STOP, no number, plan limit) is not an error: it is listed in skipped.
      if (send.skippedTotal > 0) console.warn(`reminder ${appointment.id} not sent: ${send.skipped[0]?.reason}`);
      else await saveReminder(appointment, send.sendId);
    } catch (e) {
      // The quota of the day is reached: nothing more goes out before tomorrow, stop here.
      if (e instanceof ApiError && e.code === 'quota_exceeded') { console.error('daily quota reached', e); return; }
      console.error(`reminder ${appointment.id} failed`, e);
    }
  }
}
```

<a id="webhook"></a>

## The route that receives the replies

Declare its address with `create_webhook_endpoint` or with [POST /v1/webhooks](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#creer), with the types message.received, ticked by default, and agent.action, unticked by default: tick it.

_app/api/webhooks/messagingme/route.ts_

```
import { verifyWebhook, WebhookVerificationError } from '@messagingme/sdk';
import { messagingme } from '../../../../lib/messagingme';
import { freeSlots, lastReminder, markConfirmed, move } from '../../../../lib/calendar';

// Subscribed to message.received (the Confirm button, ticked by default) and agent.action (the AI agent’s two
// actions, Reschedule request and Slot choice), unchecked by default on a webhook address: tick it.
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
  if (event.type !== 'message.received' && event.type !== 'agent.action') return new Response(null, { status: 204 });
  const contact = event.data.contact;
  // A button reply carries its label only, not the message it answers: tie it to the last reminder of the number.
  const appointment = contact?.phone ? await lastReminder(contact.phone) : null;
  if (!contact || !appointment) return new Response(null, { status: 204 });
  if (event.type === 'message.received' && event.data.button === 'Confirm') await markConfirmed(appointment);
  if (event.type === 'agent.action') {
    const { action, fields } = event.data;
    let text: string | null = null;
    if (action.name === 'Reschedule request') text = await freeSlots(appointment, 3);
    if (action.name === 'Slot choice' && fields.slot !== undefined) text = await move(appointment, String(fields.slot));
    if (text) await messagingme.POST('/v1/messages/whatsapp', { body: { contactId: contact.id, text } });
  }
  // The webhook waits 10 s for this answer, then retries the same event (same event.id): keep the work above
  // short, and your calendar functions safe to run twice.
  return new Response(null, { status: 204 });
}
```

<a id="essayer"></a>

## Trying it

- Send a test event with `send_test_event` or with [POST /v1/webhooks/{webhookId}/test](https://console.messagingme.app/developers/api/webhook-endpoints.en.md#essai): the route must answer 2xx.
- Book an appointment tomorrow with your own number, run the job, then tap Reschedule on your phone.
