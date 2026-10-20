<!-- Version Markdown de https://console.messagingme.app/developers/api/guides/appointment-booking, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/guides/appointment-booking.en.md -->

# Recette : la prise de rendez-vous

Un client demande un rendez-vous sur WhatsApp. L’agent IA note le motif et la ville, votre application lui propose trois créneaux libres de votre agenda, puis réserve celui qu’il choisit et le confirme sur WhatsApp.

<a id="prompt"></a>

## Le prompt à coller

Dans Claude Code, ouvert sur votre projet, avec le serveur MCP de Messaging Me branché. Il renvoie l’assistant vers cette recette : il n’a rien à deviner.

_Prompt_

```
Branche la prise de rendez-vous par WhatsApp dans ce projet, en suivant la recette
https://console.messagingme.app/developers/api/guides/appointment-booking.md :
1. installe le SDK : npm install github:julienmessagingme/messagingme-sdk#v0.3.1 ;
2. avec les outils Messaging Me, allume l’agent qui répond (activate_agent, puis set_default_responder) et pose sur
   lui les deux actions « Appointment request » (champs reason et city, à déclencher une fois la ville connue) et
   « Slot choice » (champ slot) ;
3. écris lib/calendar.ts relié à notre agenda (proposer trois créneaux libres, réserver celui choisi) et la route
   app/api/webhooks/messagingme/route.ts, en gardant les mêmes noms d’actions et codes de champs partout ;
4. abonne la route à agent.action, décoché par défaut, et range la clé et le secret dans les variables
   d’environnement, jamais dans le code.
N’invente aucune route ni aucun champ : ils sont dans https://api.messagingme.app/openapi.json.
```

<a id="actions"></a>

## Les deux actions de l’agent IA

Sur l’agent qui répond, ajoutez deux actions par `set_agent_action` : « Appointment request », avec deux champs texte codés reason et city (consigne : la déclencher une fois la ville connue, et dire qu’on regarde les créneaux libres), et « Slot choice », avec un champ texte codé slot (dire qu’on bloque le créneau). Votre application reçoit agent.action, une fois par jour au plus par contact et par action, avec les champs connus à ce moment. L’agent doit être allumé (activate_agent) et répondre pour l’espace (set_default_responder) : sinon aucune action ne part, sans erreur.

> **Obligatoire**
>
> Le code lit action.name et fields par leur nom exact : gardez les mêmes noms d’actions et les mêmes codes de champs dans l’agent et dans la route. Et slot est ce que l’agent a compris du client : votre agenda le recoupe avec les créneaux proposés, et ne réserve qu’un créneau encore libre, deux clients pouvant choisir le même. Sinon, répondez avec d’autres créneaux et un lien pour réserver : un second « Slot choice » le même jour n’atteindrait pas votre application.

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

Ce que le cas attend de votre agenda : reliez ces deux fonctions à votre base.

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

## La route qui reçoit les actions

Déclarez son adresse par `create_webhook_endpoint` ou par [POST /v1/webhooks](https://console.messagingme.app/developers/api/webhook-endpoints.md#creer), avec le type agent.action : il est décoché par défaut. La route répond au client par [POST /v1/messages/whatsapp](https://console.messagingme.app/developers/api/messages.md#message-whatsapp) : il vient d’écrire, la fenêtre de 24 heures est ouverte.

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

## Essayer

- Envoyez un événement d’essai par `send_test_event` ou par [POST /v1/webhooks/{webhookId}/test](https://console.messagingme.app/developers/api/webhook-endpoints.md#essai) : la route doit répondre 2xx.
- Depuis votre téléphone, écrivez au numéro de l’espace que vous voulez un rendez-vous, donnez une ville, puis choisissez un des créneaux proposés.
