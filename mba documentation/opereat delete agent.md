## Base URL

| URL | Description |
|-----|-------------|
| https://api.facebook.com/{entity_id}/delete_agent |  |

## Authorization

This API requires:

any of the following Permission: whatsapp_business_messaging

## APIs

| Method | Endpoint |
|--------|----------|
| DELETE | [/](#delete) |

<jumplink id="delete"></jumplink>
## DELETE /

Delete the Meta Business Agent

Remove the Meta Business agent from the specified WhatsApp phone number. Deletes the agent configuration and, when the last agent on the account is removed, disconnects the integration.


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |

### Responses

**200**

Agent deleted successfully

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelDeleteAgentResponse](#bizaiomnichanneldeleteagentresponse)

**400**

Bad request

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

<jumplink id="bizaiomnichanneldeleteagentresponse"></jumplink>
### BizAIOmniChannelDeleteAgentResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| deleted_agent_id | string |  | The ID of the AI agent settings that was removed, or null if there was nothing to remove. |

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