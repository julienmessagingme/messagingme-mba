<!-- Markdown version of https://console.messagingme.app/developers/api/concepts, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/concepts.md -->

# Concepts

The rules shared by several routes.

<a id="identification"></a>

## Identifying a person

A person is a record. Four keys designate it:

| Key | What it is |
| --- | --- |
| `contactId` | Record id, created with it. Shown on the mini-CRM record (“API identifier”, Copy button). |
| `externalId` | The person’s id in your tool (CRM, marketing platform), kept on the record. Unique per workspace, 512 characters at most. |
| `phone` | Phone number in international format (+33…). Without a country code: read as French. |
| `bsuid` | WhatsApp id of a person writing under a username, with no visible number. |

- At least one key, otherwise `invalid_recipient`. Unreadable number: `invalid_phone`.
- All the keys given designate the same record, otherwise `identity_conflict` and nothing is changed.
- A key the record does not carry yet is attached to it: an externalId sent with the phone number is set on the record.
- contactId is never attached: it exists, or it is unknown.

| Route | No record matches |
| --- | --- |
| POST /v1/contacts, POST /v1/contacts/batch | Record created with a phone or a bsuid. |
| POST /v1/sends | Record created with a phone, except with a whatsapp_session opening. |
| Other routes | Nothing created. |

No creation possible: `unknown_contact`.

> **Note**
>
> The sending address comes from the record, never from the key received. WhatsApp: the phone number, otherwise the BSUID. RCS: the phone number (record without one: `no_phone`).

<a id="consentement"></a>

## Consent and STOP

| Field | Effect |
| --- | --- |
| `consent` = `opted_in` | Records the consent. |
| `consent` = `opted_out` | Opts out: status, date, audit log entry. |
| `consent` missing | No change. |
| `consentSource` | Origin of the consent. Missing: api. |

> **Caution**
>
> opted_in never lifts a STOP: on an opted-out record, 409 `opted_out`, nothing is changed. Only an operator or the person themselves can re-subscribe them.

- POST /v1/sends: consent per recipient, same effect, written on the record before filtering. opted_out skips the recipient.
- Requirements of a send category: [Category](https://console.messagingme.app/developers/api/sends.en.md#categorie); of an RCS message: [POST /v1/messages/rcs](https://console.messagingme.app/developers/api/messages.en.md#message-rcs).

<a id="fenetre-24h"></a>

## The 24-hour window

- Meta rule: opens when the person writes, closes 24 hours after their last message.
- Outside the window, only a template can go out (POST /v1/sends).
- Applies to [POST /v1/messages/whatsapp](https://console.messagingme.app/developers/api/messages.en.md#message-whatsapp) and to sends opening with whatsapp_session ([Opening message](https://console.messagingme.app/developers/api/sends.en.md#ouverture)). Closed: `window_closed`.
- No window over RCS.

<a id="idempotence"></a>

## Idempotency

Only POST /v1/sends carries an idempotency key. Messages have none ([Message or send](https://console.messagingme.app/developers/api/messages.en.md#messages-simples)).

> **Required**
>
> Key required: Idempotency-Key header or idempotencyKey field. Missing: 400 `idempotency_key_required`.

_Header_

```
Idempotency-Key: confirmation-8412
```

| Case | Response |
| --- | --- |
| Same key, same body | The first call’s 201 report, as is, even if the target has changed since. Nothing is sent again. |
| Same key, different body | 422 `idempotency_key_reused` |
| First call still running | 409 `idempotency_in_progress` |
| First call cut off before its response (dropped connection, outage) | Replaying the same key returns its report if the send went through; otherwise the key stays in progress for at most 5 min, then is released, and the same key creates the send, once. |
| Header and field present and different | 400 `invalid_body` |
| Send refused (target not found, number missing…) | Key released: the fixed call goes out with the same one. |

Key lifetime: at least 24 h. Building the key for a tool that calls per contact: [The idempotency key](https://console.messagingme.app/developers/api/guides/per-contact.en.md#cle).
