## Base URL

| URL | Description |
|-----|-------------|
| https://api.facebook.com/{entity_id}/agent_config/allowlist |  |

## Authorization

This API requires:

any of the following
  - Capability: bizai_wa_enterprise_api_3p_access
  - Permission: whatsapp_business_messaging

## APIs

| Method | Endpoint |
|--------|----------|
| DELETE | [/{entry_id}](#delete-entry-id) |
| GET | [/](#get) |
| POST | [/](#post) |

<jumplink id="delete-entry-id"></jumplink>
## DELETE /{entry_id}

Remove from allowlist

Remove a specific allowlist entry by its ID


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The entity ID for the Meta Business Agent. It is a WhatsApp Business Phone Number ID. |
| entry_id | string | ✓ | The unique identifier of the allowlist entry |

### Responses

**204**

Allowlist entry successfully deleted

**404**

Not found

**Content Type**: `application/json`

**Schema**: [StandardError](#standarderror)

**401**

Unauthorized

**Content Type**: `application/json`

**Schema**: [StandardError](#standarderror)

**429**

Too many requests

**Content Type**: `application/json`

**Schema**: [StandardError](#standarderror)

**500**

Server error

**Content Type**: `application/json`

**Schema**: [StandardError](#standarderror)


<jumplink id="get"></jumplink>
## GET /

List allowlist entries

Retrieve a list of all allowlisted consumer phone numbers for the specified entity


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The entity ID for the Meta Business Agent. It is a WhatsApp Business Phone Number ID. |

### Responses

**200**

A list of all allowlist entries

**Content Type**: `application/json`

**Schema**: array of [BizAIOmniChannelAllowlistResponse](#bizaiomnichannelallowlistresponse)

**400**

Bad request

**Content Type**: `application/json`

**Schema**: [StandardError](#standarderror)

**401**

Unauthorized

**Content Type**: `application/json`

**Schema**: [StandardError](#standarderror)

**429**

Too many requests

**Content Type**: `application/json`

**Schema**: [StandardError](#standarderror)

**500**

Server error

**Content Type**: `application/json`

**Schema**: [StandardError](#standarderror)


<jumplink id="post"></jumplink>
## POST /

Add to allowlist

Add a consumer phone number to the allowlist for the specified entity


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The entity ID for the Meta Business Agent. It is a WhatsApp Business Phone Number ID. |

### Request Body (Required)

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelAllowlistRequest](#bizaiomnichannelallowlistrequest)

### Responses

**201**

The newly created allowlist entry

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelAllowlistResponse](#bizaiomnichannelallowlistresponse)

**400**

Bad request

**Content Type**: `application/json`

**Schema**: [StandardError](#standarderror)

**401**

Unauthorized

**Content Type**: `application/json`

**Schema**: [StandardError](#standarderror)

**429**

Too many requests

**Content Type**: `application/json`

**Schema**: [StandardError](#standarderror)

**500**

Server error

**Content Type**: `application/json`

**Schema**: [StandardError](#standarderror)


# Components

## Schemas

<jumplink id="bizaiomnichannelallowlistrequest"></jumplink>
### BizAIOmniChannelAllowlistRequest

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| consumer_phone_number | string | ✓ | Consumer WhatsApp phone number in E.164 format (e.g. +15551234567) |

<jumplink id="bizaiomnichannelallowlistresponse"></jumplink>
### BizAIOmniChannelAllowlistResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| id | string | ✓ | The unique identifier for this allowlist entry |
| consumer_phone_number | string | ✓ | Consumer WhatsApp phone number in E.164 format |

<jumplink id="standarderror"></jumplink>
### StandardError

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| title | string | ✓ |  |
| detail | string | ✓ |  |
| type | string |  |  |
| status | integer |  |  |

## Authentication

| Scheme | Type | Location |
|--------|------|----------|
| OAuthToken__Authorization | HTTP Bearer | Header: `Authorization` |

### Usage Examples

- **OAuthToken__Authorization**: Include `Authorization: Bearer your-token-here` in request headers

### Global Authentication Requirements

All endpoints require: OAuthToken__Authorization