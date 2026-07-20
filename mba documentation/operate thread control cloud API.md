## Base URL

| URL | Description |
|-----|-------------|
| https://api.facebook.com/business/whatsapp/phone_numbers/{phone_number_id}/thread_control |  |

## Authorization

This API requires:

any of the following Permission: whatsapp_business_messaging

## APIs

| Method | Endpoint |
|--------|----------|
| POST | [/](#post) |

<jumplink id="post"></jumplink>
## POST /

Release thread control for a consumer conversation.


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "1.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| phone_number_id | integer [min: 1] | ✓ | WhatsApp Business Account Phone Number ID |

### Request Body (Required)

**Content Type**: `application/json`

**Schema**: [ThreadControlRequest](#threadcontrolrequest)

### Responses

**200**

Thread control action result with messaging product identifier.


**Content Type**: `application/json`

**Schema**: [ThreadControlResponse](#threadcontrolresponse)


# Components

## Schemas

<jumplink id="threadcontrolrequest"></jumplink>
### ThreadControlRequest

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| messaging_product | "whatsapp" | ✓ | Messaging service used for the request. Must be "whatsapp". |
| action | One of "pass", "release" | ✓ | The thread control action to perform. Currently only "release" is supported; it relinquishes thread control and hands the conversation back to Meta Business Agent as the automatic responder. "pass" is reserved for future use. You must currently hold thread control for the conversation. |
| to | string |  | Consumer identifier (phone number or WhatsApp ID) whose thread control is being transferred. |
| recipient | string |  | Business-scoped user ID of the consumer whose thread control is being transferred. Accepted but not yet wired; provide `to` instead. |

<jumplink id="threadcontrolresponse"></jumplink>
### ThreadControlResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| messaging_product | "whatsapp" | ✓ | Messaging service used for the response. Always "whatsapp". |

## Authentication

| Scheme | Type | Location |
|--------|------|----------|
| OAuthToken__access_token | API Key | Query: `access_token` |
| OAuthToken__oauth_token | API Key | Query: `oauth_token` |
| OAuthToken__Authorization | HTTP Bearer | Header: `Authorization` |

### Usage Examples

- **OAuthToken__access_token**: Include `access_token=your-api-key-here` in query parameters

- **OAuthToken__oauth_token**: Include `oauth_token=your-api-key-here` in query parameters

- **OAuthToken__Authorization**: Include `Authorization: Bearer your-token-here` in request headers

### Global Authentication Requirements

All endpoints require: OAuthToken__access_token AND OAuthToken__oauth_token AND OAuthToken__Authorization