## Base URL

| URL | Description |
|-----|-------------|
| https://api.facebook.com/{entity_id}/agent_config/settings |  |

## Authorization

This API requires:

any of the following
  - Capability: bizai_wa_enterprise_api_3p_access
  - Permission: whatsapp_business_messaging

## APIs

| Method | Endpoint |
|--------|----------|
| GET | [/](#get) |
| PUT | [/](#put) |

<jumplink id="get"></jumplink>
## GET /

Get AI agent settings

Retrieve the current AI settings for the specified entity.


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
| agent_id | string |  | Optional agent ID. When provided, returns the specific agent configuration. When absent, returns all settings for the given channel. |

### Responses

**200**

The AI settings for the entity

**Content Type**: `application/json`

**Schema**: array of [BizAIOmniChannelSettingsResponse](#bizaiomnichannelsettingsresponse)

**400**

Bad request

**Content Type**: `application/json`

**Schema**: [StandardError](#standarderror)

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


<jumplink id="put"></jumplink>
## PUT /

Update AI agent settings

Create or fully replace the AI settings for the specified entity. All fields must be provided for a complete replacement.Note that disabling the agent will make the AI stop responding to all threads.Re-enabling it will make the AI start responding to new threads only


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
| agent_id | string |  | Optional agent ID. When provided, updates the specific agent configuration. When absent, uses create-or-fetch behavior. |

### Request Body (Required)

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelSettingsRequest](#bizaiomnichannelsettingsrequest)

### Responses

**200**

The updated AI settings for the entity

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelSettingsResponse](#bizaiomnichannelsettingsresponse)

**400**

Bad request

**Content Type**: `application/json`

**Schema**: [StandardError](#standarderror)

**404**

Not found

**Content Type**: `application/json`

**Schema**: [StandardError](#standarderror)

**401**

Unauthorized

**Content Type**: `application/json`

**Schema**: [StandardError](#standarderror)

**403**

Forbidden

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

<jumplink id="bizaiomnichannelsettingsrollout"></jumplink>
### BizAIOmniChannelSettingsRollout

Rollout configuration for the AI agent, containing the enabled flag and future gradual rollout fields


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| enabled | boolean | ✓ | Whether the AI agent is currently enabled. true for on, false for off |

<jumplink id="bizaiomnichannelsettingshandoff"></jumplink>
### BizAIOmniChannelSettingsHandoff

Settings for handing over the conversation to a human agent. Null if not configured


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| enabled | boolean | ✓ | Whether handoff to a human agent is enabled. true to enable, false to disable |
| message | string |  | The message displayed to the user when a handoff to a human agent occurs |

<jumplink id="bizaiomnichannelsettingsfollowup"></jumplink>
### BizAIOmniChannelSettingsFollowup

Settings for following up with an inactive user. Null if not configured


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| enabled | boolean | ✓ | Whether followup is enabled. true to enable, false to disable |
| followup_interval_in_seconds | One of 0, 300, 900, 1800, 3600, 7200, 28800, 86400 |  | The time in seconds of user inactivity before the followup message is sent. Setting to 0 will disable followup |
| message | string |  | The message sent to follow up with the user after inactivity |

<jumplink id="bizaiomnichannelsettingsresponse"></jumplink>
### BizAIOmniChannelSettingsResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| agent_id | string | ✓ | Unique identifier for this agent configuration. Use this ID to target a specific agent in update or delete operations |
| channel | One of "email", "instagram", "line", "messenger", "sms", "tiktok", "unknown", "webchat", "whatsapp" | ✓ | The channel/platform these settings apply to |
| rollout | [BizAIOmniChannelSettingsRollout](#bizaiomnichannelsettingsrollout) | ✓ |  |
| handoff | [BizAIOmniChannelSettingsHandoff](#bizaiomnichannelsettingshandoff) |  |  |
| followup | [BizAIOmniChannelSettingsFollowup](#bizaiomnichannelsettingsfollowup) |  |  |
| ai_audience | One of "ALLOWLISTED_ONLY", "EVERYONE" |  | Controls which consumers the AI agent responds to. EVERYONE = all consumers (default), ALLOWLISTED_ONLY = only phone numbers in the allowlist. Null for non-WhatsApp entities. |

<jumplink id="standarderror"></jumplink>
### StandardError

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| title | string | ✓ |  |
| detail | string | ✓ |  |
| type | string |  |  |
| status | integer |  |  |

<jumplink id="bizaiomnichannelsettingsrequest"></jumplink>
### BizAIOmniChannelSettingsRequest

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| rollout | [BizAIOmniChannelSettingsRollout](#bizaiomnichannelsettingsrollout) |  |  |
| handoff | [BizAIOmniChannelSettingsHandoff](#bizaiomnichannelsettingshandoff) |  |  |
| followup | [BizAIOmniChannelSettingsFollowup](#bizaiomnichannelsettingsfollowup) |  |  |
| ai_audience | One of "ALLOWLISTED_ONLY", "EVERYONE" |  | Controls which consumers the AI agent responds to. EVERYONE = all consumers (default), ALLOWLISTED_ONLY = only phone numbers in the allowlist. Only supported for WhatsApp entities. |

## Authentication

| Scheme | Type | Location |
|--------|------|----------|
| OAuthToken__Authorization | HTTP Bearer | Header: `Authorization` |

### Usage Examples

- **OAuthToken__Authorization**: Include `Authorization: Bearer your-token-here` in request headers

### Global Authentication Requirements

All endpoints require: OAuthToken__Authorization