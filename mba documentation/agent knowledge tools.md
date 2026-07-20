## Base URL

| URL | Description |
|-----|-------------|
| https://api.facebook.com/{entity_id}/agent_config/skills |  |

## Authorization

This API requires:

any of the following
  - Capability: bizai_wa_enterprise_api_3p_access
  - Permission: whatsapp_business_messaging

## APIs

| Method | Endpoint |
|--------|----------|
| DELETE | [/{skill_id}](#delete-skill-id) |
| GET | [/](#get) |
| GET | [/{skill_id}](#get-skill-id) |
| POST | [/](#post) |
| PUT | [/{skill_id}](#put-skill-id) |

<jumplink id="delete-skill-id"></jumplink>
## DELETE /{skill_id}

Delete a skill

Delete a specific AI skill by its ID

### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| skill_id | string | ✓ | The unique identifier (UUID) of the skill |

### Responses

**204**

Skill successfully deleted

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

List skills

Retrieve a list of all AI skills for the specified entity


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
| agent_id | string |  | Optional settings ID. When provided, returns skills for the specified settings. When absent, returns skills for the most recently created settings for the given channel. |

### Responses

**200**

A list of all skills

**Content Type**: `application/json`

**Schema**: array of [BizAIOmniChannelSkillsResponse](#bizaiomnichannelskillsresponse)

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


<jumplink id="get-skill-id"></jumplink>
## GET /{skill_id}

Get a skill

Retrieve a specific AI skill by its ID

### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| skill_id | string | ✓ | The unique identifier (UUID) of the skill |

### Responses

**200**

The requested skill

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelSkillsResponse](#bizaiomnichannelskillsresponse)

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


<jumplink id="post"></jumplink>
## POST /

Create a skill

Create a new AI skill for the specified entity


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
| agent_id | string |  | Optional settings ID. When provided, creates the skill under the specified settings. When absent, uses the most recently created settings for the given channel. |

### Request Body (Required)

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelSkillsRequest](#bizaiomnichannelskillsrequest)

### Responses

**201**

The newly created skill

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelSkillsResponse](#bizaiomnichannelskillsresponse)

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


<jumplink id="put-skill-id"></jumplink>
## PUT /{skill_id}

Update a skill

Update a specific AI skill by its ID

### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| skill_id | string | ✓ | The unique identifier (UUID) of the skill |

### Request Body (Required)

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelSkillsRequest](#bizaiomnichannelskillsrequest)

### Responses

**200**

The updated skill

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelSkillsResponse](#bizaiomnichannelskillsresponse)

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


# Components

## Schemas

<jumplink id="bizaiomnichannelskillsrequest"></jumplink>
### BizAIOmniChannelSkillsRequest

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| title | string |  | A human-readable name for the skill. Max 64 characters. Must contain only lowercase letters, numbers, and hyphens, and must not start or end with a hyphen. Use a descriptive title that makes the skill's purpose clear (e.g., `greeting-skill`, `product-return-policy`). Avoid generic titles like `skill-1`. |
| description | string |  | A description telling the AI when to apply this skill. Max 1024 characters. Be specific about the trigger or context — for example, "Apply when the customer first messages the agent" or "Apply when the customer asks about returns or refunds." The agent uses this to decide which skills are relevant to the current conversation. |
| skill | string |  | The body containing the actual instructions for the AI. Max 20000 characters. Write clear, non-conflicting directives. Avoid having multiple skills that each claim priority for the same situation (e.g., two skills that both say "do this first" on the first message) — the agent cannot resolve conflicting priorities and may produce duplicate or inconsistent responses. If multiple actions should happen on the same trigger, consolidate them into a single skill with an explicit sequence of steps. |

<jumplink id="bizaiomnichannelskillsresponse"></jumplink>
### BizAIOmniChannelSkillsResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| id | string | ✓ | A unique identifier for the skill |
| title | string |  | An optional, human-readable name for the skill |
| description | string |  | A description telling the AI when to apply this skill |
| skill | string | ✓ | The body containing the actual instructions for the AI. Has no specific restrictions on structure or content. |
| channel | One of "email", "instagram", "line", "messenger", "sms", "tiktok", "unknown", "webchat", "whatsapp" | ✓ | The channel/platform this skill applies to |
| created_at | integer |  | The timestamp when the skill was created |
| metadata | [Metadata](#object-metadata-1) |  | A map of key-value pairs for additional metadata |

<jumplink id="standarderror"></jumplink>
### StandardError

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| title | string | ✓ |  |
| detail | string | ✓ |  |
| type | string |  |  |
| status | integer |  |  |

## Inline Object Definitions

<jumplink id="object-metadata-1"></jumplink>
### Metadata

A map of key-value pairs for additional metadata


**Additional Properties**: string

## Authentication

| Scheme | Type | Location |
|--------|------|----------|
| OAuthToken__Authorization | HTTP Bearer | Header: `Authorization` |

### Usage Examples

- **OAuthToken__Authorization**: Include `Authorization: Bearer your-token-here` in request headers

### Global Authentication Requirements

All endpoints require: OAuthToken__Authorization