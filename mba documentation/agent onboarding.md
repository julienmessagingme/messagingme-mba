## Base URL

| URL | Description |
|-----|-------------|
| https://api.facebook.com/{entity_id}/agent_onboarding |  |

## Authorization

This API requires:

any of the following
  - Capability: bizai_wa_enterprise_api_3p_access
  - Permission: whatsapp_business_messaging

## APIs

| Method | Endpoint |
|--------|----------|
| POST | [/](#post) |

<jumplink id="post"></jumplink>
## POST /

Create an onboarding session

Trigger AI agent onboarding for the specified entity and channel. Creates the necessary entities and schedules async jobs for data preparation.


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |

### Query Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| channel | One of "email", "instagram", "line", "messenger", "sms", "tiktok", "unknown", "webchat", "whatsapp" | ✓ | The channel to onboard the AI agent for (messenger, whatsapp, instagram, tiktok, line, etc.) |

### Responses

**201**

Onboarding triggered successfully

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelOnboardingResponse](#bizaiomnichannelonboardingresponse)

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

<jumplink id="bizaiomnichannelonboardingresponse"></jumplink>
### BizAIOmniChannelOnboardingResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| agent_id | string | ✓ | The ID of the agent settings entity |

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