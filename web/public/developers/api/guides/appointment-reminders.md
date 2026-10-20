<!-- Version Markdown de https://console.messagingme.app/developers/api/guides/appointment-reminders, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/guides/appointment-reminders.en.md -->

# Recette : les rappels de rendez-vous

La veille de chaque rendez-vous, votre application envoie un rappel WhatsApp avec deux boutons. « Je confirme » marque le rendez-vous confirmé ; « Je décale » passe la main à l’agent IA, qui propose des créneaux libres, et votre application déplace le rendez-vous choisi.

<a id="prompt"></a>

## Le prompt à coller

Dans Claude Code, ouvert sur votre projet, avec le serveur MCP de Messaging Me branché. Il renvoie l’assistant vers cette recette : il n’a rien à deviner.

_Prompt_

```
Branche des rappels de rendez-vous WhatsApp dans ce projet, en suivant la recette
https://console.messagingme.app/developers/api/guides/appointment-reminders.md :
1. installe le SDK : npm install github:julienmessagingme/messagingme-sdk#v0.3.1 ;
2. avec les outils Messaging Me, crée le modèle de rappel (UTILITY, le prénom puis l’heure, deux boutons de réponse
   rapide) et, sur l’agent qui répond, les deux actions « Reschedule request » (sans champ) et « Slot choice » (champ slot) ;
3. écris lib/calendar.ts relié à notre agenda, jobs/reminders.ts (la tâche de la veille) et la route
   app/api/webhooks/messagingme/route.ts, en gardant les mêmes libellés de boutons et noms d’actions partout ;
4. abonne la route à message.received et agent.action, et range la clé et le secret dans les variables
   d’environnement, jamais dans le code.
N’invente aucune route ni aucun champ : ils sont dans https://api.messagingme.app/openapi.json.
```

<a id="modele"></a>

## Le modèle de rappel

Un modèle UTILITY à deux variables (le prénom, puis l’heure) et deux boutons de réponse rapide, 25 caractères au plus chacun. Créez-le par `create_template` (serveur MCP) ou par [POST /v1/templates](https://console.messagingme.app/developers/api/templates.md#creer), puis attendez l’approbation de Meta, souvent en quelques minutes.

> **Obligatoire**
>
> Un bouton touché arrive dans message.received par son LIBELLÉ (data.button), sans dire à quel message il répond. Le code compare ce libellé et retrouve le dernier rappel envoyé au numéro : gardez le même libellé dans le modèle et dans la route.

<a id="actions"></a>

## Les deux actions de l’agent IA

Sur l’agent qui répond, ajoutez deux actions par `set_agent_action` : « Reschedule request », sans champ (dire qu’on regarde les créneaux libres), et « Slot choice », avec un champ texte codé slot (dire qu’on bloque le créneau). Votre application reçoit agent.action, une fois par jour au plus par contact et par action.

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

Ce que le cas attend de votre agenda : reliez ces fonctions à votre base.

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
/** Moves the appointment to the chosen slot (twice the same slot moves it once), and returns the confirmation. */
export async function move(appointment: Appointment, slot: string): Promise<string> { return todo('move'); }
```

La tâche de la veille, lancée chaque soir par le planificateur de votre hébergeur. Elle envoie par [POST /v1/sends](https://console.messagingme.app/developers/api/sends.md#envoi), avec une clé d’idempotence tirée du rendez-vous : relancée, elle n’envoie pas deux fois.

_jobs/reminders.ts_

```
import { messagingme } from '../lib/messagingme';
import { saveReminder, tomorrowsAppointments } from '../lib/calendar';

// Run once a day, the evening before (a cron of your host). The template appointment_reminder has two variables,
// the first name then the time, and two quick reply buttons: Confirm and Reschedule.
export async function dayBeforeReminders(): Promise<void> {
  for (const appointment of await tomorrowsAppointments()) {
    const send = await messagingme.POST('/v1/sends', {
      body: {
        target: { template: { name: 'appointment_reminder', language: 'en' } },
        recipients: [{ phone: appointment.phone, variables: { firstName: appointment.firstName, time: appointment.time } }],
        params: [
          { position: 1, source: { type: 'variable', key: 'firstName' } },
          { position: 2, source: { type: 'variable', key: 'time' } },
        ],
      },
      // Run twice for the same appointment, the job does not send twice.
      idempotencyKey: `reminder-${appointment.id}`,
    });
    await saveReminder(appointment, send.sendId);
  }
}
```

<a id="webhook"></a>

## La route qui reçoit les réponses

Déclarez son adresse par `create_webhook_endpoint` ou par [POST /v1/webhooks](https://console.messagingme.app/developers/api/webhook-endpoints.md#creer), avec les types message.received et agent.action : ils sont décochés par défaut.

_app/api/webhooks/messagingme/route.ts_

```
import { verifyWebhook, WebhookVerificationError } from '@messagingme/sdk';
import { messagingme } from '../../../../lib/messagingme';
import { freeSlots, lastReminder, markConfirmed, move } from '../../../../lib/calendar';

// Subscribed to message.received (the Confirm button) and agent.action (the AI agent’s two actions,
// Reschedule request and Slot choice). Both types are unchecked by default on a webhook address.
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
  // Answer fast (under 10 s): a slow job runs after, otherwise the webhook is retried.
  return new Response(null, { status: 204 });
}
```

<a id="essayer"></a>

## Essayer

- Envoyez un événement d’essai par `send_test_event` ou par [POST /v1/webhooks/{webhookId}/test](https://console.messagingme.app/developers/api/webhook-endpoints.md#essai) : la route doit répondre 2xx.
- Prenez un rendez-vous demain avec votre propre numéro, lancez la tâche, puis touchez « Je décale » sur votre téléphone.
