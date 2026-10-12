<!-- Markdown version of https://console.messagingme.app/developers/api/guides/per-contact, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/guides/per-contact.md -->

# Connecting a tool that calls per contact

For a tool (orchestration, CRM, marketing) that calls once per contact, with a body filled from the profile. Six steps; steps 3 to 5 are set up once.

## 1 The URL and the header

_URL_

```
POST https://api.messagingme.app/v1/sends
```

Same header for every contact; key with the sends:create scope:

_Header_

```
Authorization: Bearer mba_xxxxxxxxxxxxxxxx
```

## 2 The body

One recipient per call: externalId and phone number. The externalId stays on the record and finds it on later calls.

_Body_

```
{
  "idempotencyKey": "relance-panier-crm-7781-etape-3-2026-09-24",
  "target": {
    "template": {
      "name": "relance_panier",
      "language": "fr"
    }
  },
  "recipients": [
    {
      "externalId": "crm-7781",
      "phone": "+33612345678",
      "consent": "opted_in",
      "consentSource": "outil-marketing",
      "variables": {
        "produit": "Veste en lin"
      }
    }
  ],
  "params": [
    {
      "position": 1,
      "source": {
        "type": "variable",
        "key": "produit"
      }
    }
  ]
}
```

<a id="cle"></a>

## 3 The idempotency key

In the body (idempotencyKey), filled per contact. Composition: contact id, plus whatever makes this pass unique (step, journey entry date).

> **Caution**
>
> Key built from the contact id alone: a second legitimate pass is taken for a replay, and does not go out.

[Idempotency](https://console.messagingme.app/developers/api/concepts.en.md#idempotence)

## 4 Consent

consent and consentSource on every call, from the tool that holds the consent. [Consent and STOP](https://console.messagingme.app/developers/api/concepts.en.md#consentement).

## 5 Variables

variables: the values specific to this contact (order number, product). Nothing is written on the record.

## 6 Try the call

A refusal shows in the 201 response (skipped recipient) or in the error code (target not found). Tool that does not read responses: one call by hand first.

_Command_

```
curl -X POST https://api.messagingme.app/v1/sends \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "idempotencyKey": "relance-panier-crm-7781-etape-3-2026-09-24",
  "target": {
    "template": {
      "name": "relance_panier",
      "language": "fr"
    }
  },
  "recipients": [
    {
      "externalId": "crm-7781",
      "phone": "+33612345678",
      "consent": "opted_in",
      "consentSource": "outil-marketing",
      "variables": {
        "produit": "Veste en lin"
      }
    }
  ],
  "params": [
    {
      "position": 1,
      "source": {
        "type": "variable",
        "key": "produit"
      }
    }
  ]
}'
```

[POST /v1/sends](https://console.messagingme.app/developers/api/sends.en.md#envoi) · [Errors](https://console.messagingme.app/developers/api/reference.en.md#erreurs)
