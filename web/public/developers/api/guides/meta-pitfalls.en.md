<!-- Markdown version of https://console.messagingme.app/developers/api/guides/meta-pitfalls, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/guides/meta-pitfalls.md -->

# Meta pitfalls

Messaging Me goes through Meta’s official WhatsApp platform. Its rules apply to every message, whatever tool sends it: here they are, with the code you will get when one of them blocks.

<a id="fenetre"></a>

## The 24-hour window

A free-form message (text, image, buttons) only goes out within 24 hours of the person’s last message. After that, only a template approved by Meta can go out. When it knows, the API refuses before Meta: [`window_closed`](https://console.messagingme.app/developers/api/errors.en.md#window_closed); otherwise Meta answers [`131047`](https://console.messagingme.app/developers/api/errors.en.md#meta-131047).

A conversation says whether its window is open: [GET /v1/conversations/{conversationId}](https://console.messagingme.app/developers/api/conversations.en.md#lire). [The rule in detail](https://console.messagingme.app/developers/api/concepts.en.md#fenetre-24h).

<a id="modeles"></a>

## Templates and their review

- Meta reviews each template, in a few minutes or up to 24 hours. Only an approved template goes out.
- Three categories: marketing, utility (transactional) and authentication. Meta can change the category you chose, and the price changes with it.
- A template can be paused for low quality ([`132015`](https://console.messagingme.app/developers/api/errors.en.md#meta-132015)), then permanently disabled if it happens again ([`132016`](https://console.messagingme.app/developers/api/errors.en.md#meta-132016)).
- A send’s parameters must match the template, in number ([`132000`](https://console.messagingme.app/developers/api/errors.en.md#meta-132000)) and format ([`132012`](https://console.messagingme.app/developers/api/errors.en.md#meta-132012)).
- Follow the status: [GET /v1/templates/{name}](https://console.messagingme.app/developers/api/templates.en.md#statut), or the event `template.status_changed`.

<a id="facturation"></a>

## What Meta charges for

Meta charges template messages by category and by the recipient’s country. Service messages (replies within the 24-hour window) have their own terms, which changed on October 1, 2026. Messaging Me does not set these prices: Meta’s official rate card is the reference.

[Meta’s pricing](https://developers.facebook.com/docs/whatsapp/pricing)

<a id="paiement"></a>

## The card in Business Manager

Meta requires a valid payment method on the WhatsApp account for what it charges, starting with templates, whatever the Messaging Me plan. Without it: [`131042`](https://console.messagingme.app/developers/api/errors.en.md#meta-131042).

<a id="consentement"></a>

## Consent and STOP

Meta requires consent before writing first to someone. Messaging Me keeps it on the record and refuses a marketing send without it ([`no_consent`](https://console.messagingme.app/developers/api/errors.en.md#no_consent)). A person who replies STOP is opted out ([`opted_out`](https://console.messagingme.app/developers/api/errors.en.md#opted_out)): the API never resubscribes them.

The person can also refuse your business’s marketing within WhatsApp itself: [`131050`](https://console.messagingme.app/developers/api/errors.en.md#meta-131050). [The rule in detail](https://console.messagingme.app/developers/api/concepts.en.md#consentement).

<a id="qualite"></a>

## Number quality

Meta rates each number’s quality from the blocks and reports it receives, and decides how many different people it can reach per 24 hours. Low quality restricts sending ([`131048`](https://console.messagingme.app/developers/api/errors.en.md#meta-131048)): a Messaging Me campaign then pauses, and nothing restarts it on its own. Write to people who agreed to it, with content they expect.

<a id="debit"></a>

## Throughput

- A number has a maximum sending throughput: [`130429`](https://console.messagingme.app/developers/api/errors.en.md#meta-130429).
- Too many messages to the same person in a short time: [`131056`](https://console.messagingme.app/developers/api/errors.en.md#meta-131056). The other recipients are not affected.
- The API also has its own limits, per minute and per day: [`rate_limited`](https://console.messagingme.app/developers/api/errors.en.md#rate_limited), [`quota_exceeded`](https://console.messagingme.app/developers/api/errors.en.md#quota_exceeded) (wait for `retry-after`). [The limits](https://console.messagingme.app/developers/api/reference.en.md#debit).

<a id="marketing"></a>

## The per-person marketing limit

Meta limits how many marketing messages a person receives, across all businesses. Beyond it, your message is not delivered ([`131049`](https://console.messagingme.app/developers/api/errors.en.md#meta-131049)), without you having done anything wrong. Do not retry right away: wait at least 24 hours.

<a id="nom-affiche"></a>

## The display name

The name the person sees for the number goes through Meta’s review. Check its status in WhatsApp Manager before sending, and fix it there if it is rejected.

<a id="injoignable"></a>

## The unreachable number

A number that is not on WhatsApp, a person who has not accepted WhatsApp’s terms or whose app is too old: [`131026`](https://console.messagingme.app/developers/api/errors.en.md#meta-131026). Use another channel (RCS, email).

<a id="medias"></a>

## Files

- Meta keeps a received file for 7 days only: download it as soon as the event `message.received` arrives ([GET /v1/messages/{messageId}/media](https://console.messagingme.app/developers/api/conversations.en.md#media)). After that: [`media_expired`](https://console.messagingme.app/developers/api/errors.en.md#media_expired).
- A file sent must have a type and size WhatsApp accepts: [`131053`](https://console.messagingme.app/developers/api/errors.en.md#meta-131053).

> **Note**
>
> All the codes, and what Messaging Me already does on its own: [Meta errors](https://console.messagingme.app/developers/api/errors.en.md#meta).
