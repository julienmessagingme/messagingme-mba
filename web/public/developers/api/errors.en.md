<!-- Markdown version of https://console.messagingme.app/developers/api/errors, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/errors.md -->

# Error catalog

Every error response of the API carries a JSON body with error, a French sentence for a human, and code, a stable identifier for a program. Rely on code, never on the sentence.

<a id="forme"></a>

## The shape of an error

_JSON_

```
{
  "error": "fenêtre de 24 h fermée : cette personne n’a pas écrit récemment. Utilisez un template (POST /v1/sends).",
  "code": "window_closed"
}
```

- `metaCode`: on meta_rejected only, Meta’s error number (see below), or null when Meta gives none.
- `upgradeUrl`: on a 402, the page where the workspace plan is changed.
- `retry-after`: on a 429, the header that says how many seconds to wait.

> **Caution**
>
> A 5xx may arrive without this body: a generic error page sometimes replaces it on the way. Treat it as internal_error: retry with a growing delay, and replay a send with the same idempotency key.

<a id="codes"></a>

## API codes

A given refusal carries the same code everywhere. Some also come as the skip reason of a recipient of [POST /v1/sends](https://console.messagingme.app/developers/api/sends.en.md#envoi): the send goes out for the others.

<a id="invalid_body"></a>

### `invalid_body` 400

Malformed body. The message names the faulty field.

What to do: Fix the field the message names. Always send Content-Type: application/json.

<a id="invalid_recipient"></a>

### `invalid_recipient` 400, also a skip reason

No record key (contactId, externalId, phone, bsuid).

What to do: Identify the person with at least one key: contactId, externalId, phone or bsuid.

<a id="invalid_phone"></a>

### `invalid_phone` 400, also a skip reason

Unreadable phone number.

What to do: Write the number in international format, with its country code (+33612345678).

<a id="unauthorized"></a>

### `unauthorized` 401

Key missing, malformed, unknown or revoked.

What to do: Check the Authorization: Bearer mba_… header; if the key was revoked, create one in Developers > API keys.

<a id="missing_scope"></a>

### `missing_scope` 403

The key lacks the scope the route requires.

What to do: Create a key that carries the route’s scope (the scope list is on the Authentication page).

<a id="tenant_locked"></a>

### `tenant_locked` 403

Workspace suspended: the key is valid, but the workspace can no longer read or send through the API. No need to create a new key.

What to do: No need for a new key: an admin checks in the console why the workspace is suspended.

<a id="unknown_contact"></a>

### `unknown_contact` 404, also a skip reason

No record matches, and the route does not create one.

What to do: Create the record first (POST /v1/contacts), or check the key given.

<a id="duplicate"></a>

### `duplicate` skip reason only

The same recipient appears twice in the send.

What to do: Remove the duplicate from the recipient list; it received only one message.

<a id="identity_conflict"></a>

### `identity_conflict` 409, also a skip reason

The keys given designate two different records, or this external id is already carried by another record. Nothing is written.

What to do: Give a single key, or fix the external id carried by the other record: nothing was written.

<a id="blocked_contact"></a>

### `blocked_contact` 409, also a skip reason

Blocked record.

What to do: An admin unblocks the record in the console, if needed.

<a id="opted_out"></a>

### `opted_out` 409, also a skip reason

Opted out, in general, or from RCS for an RCS send.

What to do: Stop writing to this person: they said STOP. The API does not resubscribe them; only an operator or the person themselves can.

<a id="no_consent"></a>

### `no_consent` 409, also a skip reason

Missing consent: a marketing send to someone not opted_in, or a free RCS to someone who neither consented nor wrote.

What to do: Set the collected consent on the record (consent, consentSource) before a marketing send.

<a id="window_closed"></a>

### `window_closed` 422, also a skip reason

24-hour window closed: only a template can go out. On a number linked by QR code, which never writes first: the person never wrote.

What to do: Send an approved template (POST /v1/sends): a free-form message only goes out within 24 hours of the person’s last message.

<a id="missing_variable"></a>

### `missing_variable` skip reason only

A variable is missing for this recipient, with no fallback.

What to do: Fill the variable on the record, or give the parameter a fallback value.

<a id="no_phone"></a>

### `no_phone` 422, also a skip reason

Record without a phone number, which RCS, or a reply outside the 24 h window from a number linked by QR code, requires.

What to do: Add a phone number to the record.

<a id="rcs_unreachable"></a>

### `rcs_unreachable` 422

This number is not reachable over RCS (learned from a previous send).

What to do: The number has no RCS: use WhatsApp.

<a id="rcs_not_enabled"></a>

### `rcs_not_enabled` 409

The RCS channel is not active on this workspace.

What to do: Send over WhatsApp, or have RCS enabled on the workspace.

<a id="no_whatsapp_number"></a>

### `no_whatsapp_number` 409

No WhatsApp number on this workspace.

What to do: An admin connects a WhatsApp number to the workspace from the console Home page.

<a id="number_unlinked"></a>

### `number_unlinked` 409

The workspace’s WhatsApp number is unlinked from the Home page: nothing goes out over WhatsApp until an admin relinks it. Returned by POST /v1/messages/whatsapp, and by POST /v1/sends when the first message goes out over WhatsApp.

What to do: An admin relinks the number from the console Home page.

<a id="number_suspended"></a>

### `number_suspended` 409

The subscription of the provided WhatsApp number is 7 days overdue, or ended: nothing goes out over WhatsApp until it is renewed. Returned by POST /v1/messages/whatsapp, and by POST /v1/sends when the first message goes out over WhatsApp.

What to do: Settle the number subscription in the console: sends resume on payment.

<a id="scenario_not_found"></a>

### `scenario_not_found` 404

Scenario not found.

What to do: Read the catalog (GET /v1/scenarios) and use an existing scenario code.

<a id="node_not_found"></a>

### `node_not_found` 404

Block not found.

What to do: Read the catalog (GET /v1/scenarios): the block does not exist in the scenario’s published version.

<a id="template_not_found"></a>

### `template_not_found` 404

Template missing, or not approved yet.

What to do: Read the catalog (GET /v1/templates); a template pending at Meta only appears once approved.

<a id="rcs_message_not_found"></a>

### `rcs_message_not_found` 404

RCS message not found in the library.

What to do: Read the library (GET /v1/rcs-messages) and use an existing name.

<a id="send_not_found"></a>

### `send_not_found` 404

Unknown send.

What to do: Check the sendId returned by POST /v1/sends.

<a id="meta_rejected"></a>

### `meta_rejected` 422

Meta refused the request: its reason follows “Meta:”, and metaCode carries Meta’s error number (null if it gives none).

What to do: Look up metaCode in Meta’s errors, further down this page, and apply its fix.

<a id="invalid_header_media"></a>

### `invalid_header_media` 422

The template header file could not be fetched from its address: the reason follows.

What to do: Serve the header file at a public https address, with the right type and under the allowed size.

<a id="meta_auth_failed"></a>

### `meta_auth_failed` 409

Meta refuses the workspace token: reconnect the WhatsApp account from the console.

What to do: An admin clicks “Renew the Meta connection” on the console Home page.

<a id="field_exists"></a>

### `field_exists` 409

A field already has this key, or the label is that of a base field.

What to do: Reuse the existing field (GET /v1/fields), or pick another label.

<a id="webhook_not_found"></a>

### `webhook_not_found` 404

Webhook endpoint unknown to this workspace.

What to do: Check the endpoint id (GET /v1/webhooks).

<a id="delivery_not_found"></a>

### `delivery_not_found` 404

Webhook delivery unknown.

What to do: Check the id in the endpoint’s log (GET /v1/webhooks/{webhookId}/deliveries).

<a id="delivery_not_replayable"></a>

### `delivery_not_replayable` 409

Delivery unknown to this workspace, still pending, or a test: nothing to replay.

What to do: Wait for the retries to end; a test is never replayed.

<a id="webhooks_unavailable"></a>

### `webhooks_unavailable` 503

The instance cannot encrypt secrets: retry later.

What to do: Retry later.

<a id="template_rejected"></a>

### `template_rejected` 422

The template is refused before Meta (a link could not be tracked): the reason follows.

What to do: Fix the template according to the reason given, then create it again.

<a id="conversation_not_found"></a>

### `conversation_not_found` 404

Conversation unknown to this workspace.

What to do: Check the id (GET /v1/conversations).

<a id="message_not_found"></a>

### `message_not_found` 404

Message unknown to this workspace.

What to do: Check the message id (GET /v1/conversations/{conversationId}/messages).

<a id="invalid_cursor"></a>

### `invalid_cursor` 400

Unreadable cursor: send back a page’s nextCursor as is.

What to do: Send back the previous page’s nextCursor as is.

<a id="no_media"></a>

### `no_media` 404

This message carries no received file.

What to do: Read the message type before asking for its file.

<a id="media_expired"></a>

### `media_expired` 410

Meta keeps a received file for 7 days only.

What to do: Too late for this file: download it as soon as the message.received event arrives.

<a id="media_unavailable"></a>

### `media_unavailable` 422

Meta did not return the file, or it is too large: retry.

What to do: Retry a little later.

<a id="scenario_ambiguous"></a>

### `scenario_ambiguous` 409

Several scenarios have this name: use the scn_ code.

What to do: Designate the scenario by its scn_… code rather than by its name.

<a id="unsendable_target"></a>

### `unsendable_target` 422

The target cannot go out like this. The message says why.

What to do: Read the reason, then pick a sendable target: an approved template, a published scenario.

<a id="template_category_unknown"></a>

### `template_category_unknown` 422

The template category cannot be read at Meta: the send is refused rather than guessed.

What to do: Retry later; if it persists, check the template in WhatsApp Manager.

<a id="idempotency_key_required"></a>

### `idempotency_key_required` 400

Idempotency key missing (header or body).

What to do: Add the Idempotency-Key header (or idempotencyKey in the body).

<a id="idempotency_in_progress"></a>

### `idempotency_in_progress` 409

A send with this key is in progress.

What to do: Wait for the first call to finish, then replay with the same key: it returns the same result.

<a id="idempotency_key_reused"></a>

### `idempotency_key_reused` 422

This key was already used for a different body.

What to do: Use a new key for a different body.

<a id="rate_limited"></a>

### `rate_limited` 429

Rate limit exceeded, here or at Meta (a temporary Meta limit or outage): wait for retry-after.

What to do: Wait retry-after seconds, then retry.

<a id="quota_exceeded"></a>

### `quota_exceeded` 429

Daily workspace quota reached (templates, replies or written contacts), or exceeded by this request: retry-after gives the wait until midnight, Paris time. A smaller request may still go through.

What to do: Wait for the reset that retry-after gives (midnight, Paris time), or send fewer items in one call.

<a id="plan_feature_unavailable"></a>

### `plan_feature_unavailable` 402

This feature is not included in the workspace plan: upgradeUrl leads to the plan page.

What to do: Change plan on the page upgradeUrl gives.

<a id="plan_limit_reached"></a>

### `plan_limit_reached` 402, also a skip reason

A workspace plan limit is reached (contacts, templates this month…): upgradeUrl leads to the plan page. Replies within the 24-hour window are never affected.

What to do: Change plan on the page upgradeUrl gives, or wait for the limit to reset.

<a id="route_not_found"></a>

### `route_not_found` 404

No route at this address for this method: check the method and path in the OpenAPI contract.

What to do: Check the method and path in the OpenAPI contract (GET /openapi.json).

<a id="internal_error"></a>

### `internal_error` 500

An outage on our side, or Meta unreachable. Retry; a send is replayed with the same idempotency key. A 5xx may arrive without this body (generic error page).

What to do: Retry, with a growing delay; a send is replayed without duplicates using the same idempotency key.

<a id="meta"></a>

## Meta errors

Meta sometimes refuses a message for a reason of its own. Its error number arrives in four places:

- `metaCode` of a 422 meta_rejected refusal, when Meta refuses on the spot;
- `data.meta_code` of the message.failed event, when the message fails after it went out;
- `error.code` of a message read with GET /v1/messages/{messageId};
- `error.metaCode` of a recipient in a send’s follow-up (GET /v1/sends/{sendId}).

The codes below are the ones that concern a Messaging Me workspace. The full list is in Meta’s Cloud API documentation.

### The recipient

<a id="meta-131047"></a>

#### `131047`

More than 24 hours since the person’s last message: the window is closed.

What to do: Send an approved template (POST /v1/sends) instead of a free-form message.

What Messaging Me already does: When it knows, the API refuses before Meta: window_closed.

<a id="meta-131026"></a>

#### `131026`

Undeliverable message: the number is not on WhatsApp, the person has not accepted WhatsApp’s terms, or their app is too old.

What to do: Use another channel (RCS, email), or ask the person to update WhatsApp.

What Messaging Me already does: A multi-channel campaign moves to the next channel. Otherwise, when retry is on (the campaign box, or the workspace setting for an API send), it retries once, then marks the contact unreachable on WhatsApp.

<a id="meta-131049"></a>

#### `131049`

Marketing message not delivered: Meta limits the marketing each person receives, to preserve engagement.

What to do: Do not retry right away: wait at least 24 hours. Meta does not say when the limit lifts.

What Messaging Me already does: When retry is on (the campaign box, or the workspace setting for an API send), it is tried again the next morning.

<a id="meta-131050"></a>

#### `131050`

The person has opted out, in WhatsApp, of your business’s marketing messages.

What to do: Do not retry, and stop sending them marketing.

<a id="meta-131021"></a>

#### `131021`

The sender and the recipient are the same number.

What to do: Send to a number other than the workspace’s own.

<a id="meta-130497"></a>

#### `130497`

The account cannot message people in this country.

What to do: This recipient cannot be reached by this account: check the allowed countries in Meta’s policy.

### Templates

<a id="meta-132000"></a>

#### `132000`

The number of parameters does not match the template.

What to do: Give a value to each {{n}} of the template, no more, no less (params of POST /v1/sends).

<a id="meta-132001"></a>

#### `132001`

The template does not exist in this language, or it is not approved.

What to do: Check the template name, language and status (GET /v1/templates/{name}).

<a id="meta-132012"></a>

#### `132012`

A parameter does not have the format the template expects.

What to do: Follow the format defined in the template: text, currency, date, header file.

<a id="meta-132015"></a>

#### `132015`

Template paused by Meta for low quality.

What to do: Edit it to improve its quality, then send again once re-approved. The template.status_changed event reports it.

<a id="meta-132016"></a>

#### `132016`

Template permanently disabled, after repeated pauses.

What to do: Create a new template, with different content.

<a id="meta-132018"></a>

#### `132018`

The template parameters fail Meta’s validation.

What to do: Read the error detail, fix the parameters and send again. A template accepted at creation can still be refused this way when sent.

<a id="meta-134100"></a>

#### `134100`

The Marketing Messages API only accepts marketing category templates.

What to do: Send again: Meta probably reclassified the template between the reading of its category and the send.

What Messaging Me already does: Messaging Me reads the template category at Meta and only sends marketing templates through this API.

<a id="meta-134101"></a>

#### `134101`

The template was created, or reused after 7 days without sending, less than 10 minutes ago: Meta is still syncing it.

What to do: Wait 10 minutes, then send again.

What Messaging Me already does: Messaging Me immediately sends the message through the Cloud API instead, at the same price: you only see it if that second send fails too.

<a id="meta-134102"></a>

#### `134102`

The template is unavailable for the Marketing Messages API: its sync failed, or the account is not eligible.

What to do: Check the WhatsApp account eligibility in WhatsApp Manager, then contact Meta support if it is fine.

### Content and files

<a id="meta-100"></a>

#### `100`

Invalid parameter in the request.

What to do: Read Meta’s message, which names the field, and fix the request.

<a id="meta-131008"></a>

#### `131008`

Required parameter missing.

What to do: Complete the body following Meta’s format (POST /v1/messages).

<a id="meta-131009"></a>

#### `131009`

Invalid parameter value: a button title too long, a malformed URL…

What to do: Read Meta’s message, which names the value, and fix it.

<a id="meta-131051"></a>

#### `131051`

Unsupported message type.

What to do: Use a type WhatsApp accepts: text, image, document, template…

<a id="meta-131052"></a>

#### `131052`

The file sent by the person could not be downloaded.

What to do: Ask the person to send it again.

<a id="meta-131053"></a>

#### `131053`

Uploading a file to Meta failed: type or size refused.

What to do: Check the file type and size, then send again.

### Throughput and quality

<a id="meta-130429"></a>

#### `130429`

The number’s sending throughput is exceeded.

What to do: Spread out sends and retry a few seconds later.

What Messaging Me already does: Retried on its own; a campaign pauses and resumes by itself.

<a id="meta-131048"></a>

#### `131048`

Sending restricted for this number: too many messages blocked or reported as spam.

What to do: Check the number’s quality in WhatsApp Manager, review targeting and content before resuming.

What Messaging Me already does: A campaign goes into a quality pause that nothing lifts automatically.

<a id="meta-131056"></a>

#### `131056`

Too many messages from the same number to the same recipient in a short time.

What to do: Wait before writing to this recipient again; the others are not affected.

What Messaging Me already does: Messaging Me retries it on its own several times before reporting the failure.

<a id="meta-4"></a>

#### `4`

The app’s call limit at Meta is reached.

What to do: Slow down, then retry later.

What Messaging Me already does: Messaging Me retries it on its own several times before reporting the failure.

<a id="meta-80007"></a>

#### `80007`

The WhatsApp account’s call limit is reached.

What to do: Slow down, then retry later.

### The account and the connection

<a id="meta-190"></a>

#### `190`

The workspace’s access token has expired or been revoked.

What to do: An admin clicks “Renew the Meta connection” on the console Home page.

What Messaging Me already does: Through the API, it comes out as 409 meta_auth_failed, on every route.

<a id="meta-10"></a>

#### `10`

A permission is missing or was removed on the WhatsApp account.

What to do: Renew the Meta connection, accepting all the permissions requested.

<a id="meta-131042"></a>

#### `131042`

Payment method problem on the WhatsApp account.

What to do: Add or fix the card in Business Manager (Billing): Meta requires it for what it charges, starting with templates, whatever the Messaging Me plan.

<a id="meta-368"></a>

#### `368`

Account restricted or disabled for breaking Meta’s rules.

What to do: Read the notice in WhatsApp Manager and appeal if needed: nothing will go out until it is lifted.

<a id="meta-131031"></a>

#### `131031`

Account locked by Meta, or verification failed (wrong two-step PIN).

What to do: Check the account status in WhatsApp Manager; for the PIN, set it again.

### Number registration

<a id="meta-133006"></a>

#### `133006`

The number must be verified before it is registered.

What to do: Finish verifying the number (code by SMS or call) from the console.

<a id="meta-133016"></a>

#### `133016`

Too many registration attempts for the number in a short time.

What to do: Wait until it is unblocked, up to 72 hours, before retrying.

<a id="meta-136024"></a>

#### `136024`

The number is already verified: Meta refuses a new code request.

What to do: Go straight to registration, without asking for another code.

### Temporary failures

<a id="meta-131000"></a>

#### `131000`

Unknown failure at Meta.

What to do: Retry; if it persists on the same message, change the content.

What Messaging Me already does: A file upload is retried on its own: about one in ten fails this way.

<a id="meta-131016"></a>

#### `131016`

Meta’s service is temporarily unavailable.

What to do: Retry later.

What Messaging Me already does: Messaging Me retries it on its own several times before reporting the failure.

<a id="meta-1"></a>

#### `1`

Unknown Meta API error, often temporary.

What to do: Retry later.

What Messaging Me already does: Messaging Me retries it on its own several times before reporting the failure.

<a id="meta-2"></a>

#### `2`

Meta API service temporarily unavailable.

What to do: Retry in a few minutes.

What Messaging Me already does: Messaging Me retries it on its own several times before reporting the failure.
