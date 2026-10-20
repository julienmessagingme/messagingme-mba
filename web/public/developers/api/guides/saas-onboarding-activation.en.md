<!-- Markdown version of https://console.messagingme.app/developers/api/guides/saas-onboarding-activation, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/guides/saas-onboarding-activation.md -->

# Recipe: SaaS user onboarding

At sign-up, your app sends the welcome on WhatsApp, with a button that leads to the first action in your product. It only goes to the user who ticked the WhatsApp box on the form.

<a id="prompt"></a>

## The prompt to paste

In Claude Code, opened on your project, with the Messaging Me MCP server connected. It points the assistant to this recipe: it has nothing to guess.

_Prompt_

```
Add the WhatsApp welcome for new users to this project, following the recipe
https://console.messagingme.app/developers/api/guides/saas-onboarding-activation.en.md:
1. install the SDK: npm install github:julienmessagingme/messagingme-sdk#v0.3.1;
2. with the Messaging Me tools, create the welcome template (MARKETING, the first name, a URL button to the page
   that gets the user started);
3. add to the sign-up form a “Get my getting-started tips on WhatsApp” box, unticked by default, and write
   app/signup.ts that only sends to those who ticked it, with consent opted_in;
4. keep the key in environment variables, never in the code.
Do not invent any route or field: they are in https://api.messagingme.app/openapi.json.
```

<a id="modele"></a>

## The welcome template

A MARKETING template with one variable (the first name) and a URL button to the page that gets the user started. Create it with `create_template` (MCP server) or with [POST /v1/templates](https://console.messagingme.app/developers/api/templates.en.md#creer), then wait for Meta’s approval; `get_template_status` confirms it.

> **Required**
>
> A welcome that invites people to use the product is marketing for Meta, not utility. A marketing template only goes to a contact who consented: without the ticked box, the send is refused (no_consent).

<a id="consentement"></a>

## The consent box

Add to the sign-up form a “Get my getting-started tips on WhatsApp” box, unticked by default. The send passes consent opted_in and the consent source: the API writes them on the contact before the marketing filter.

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

The welcome, called once the account exists. It goes through [POST /v1/sends](https://console.messagingme.app/developers/api/sends.en.md#envoi), with an idempotency key taken from the user: replayed within 24 hours, it does not send twice.

_app/signup.ts_

```
import { messagingme } from '../lib/messagingme';

// Call it once the account exists. The template welcome is MARKETING (it invites to use the product): it only
// goes to someone who ticked the WhatsApp box on the sign-up form. It has one variable, the first name, and a URL
// button to the page that creates the first schedule.
export async function sendWelcome(user: { id: string; phone: string; firstName: string; whatsappOptIn: boolean }): Promise<void> {
  if (!user.whatsappOptIn) return;
  await messagingme.POST('/v1/sends', {
    body: {
      target: { template: { name: 'welcome', language: 'en' } },
      recipients: [{
        phone: user.phone,
        variables: { firstName: user.firstName },
        // The ticked box is the consent: written on the contact before the marketing filter.
        consent: 'opted_in',
        consentSource: 'signup form',
      }],
      params: [{ position: 1, source: { type: 'variable', key: 'firstName' } }],
    },
    // Replayed within 24 hours (the life of the key), the welcome does not send twice.
    idempotencyKey: `welcome-${user.id}`,
  });
}
```

<a id="essayer"></a>

## Trying it

- Sign up with your own number, ticking the box: the welcome arrives, and its button opens your app.
- Sign up without ticking the box: nothing is sent.
