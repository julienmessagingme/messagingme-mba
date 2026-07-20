## Base URL

| URL | Description |
|-----|-------------|
| https://api.facebook.com/{entity_id}/agent_event |  |

## Authorization

This API requires:

any of the following
  - Capability: bizai_wa_enterprise_api_3p_access
  - Permission: whatsapp_business_messaging

## APIs

| Method | Endpoint |
|--------|----------|
| GET | [/{agent_event_id}](#get-agent-event-id) |
| POST | [/](#post) |

<jumplink id="get-agent-event-id"></jumplink>
## GET /{agent_event_id}

Get an agent event status

Retrieve the current processing status of a previously submitted agent event, identified by its ID.


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| agent_event_id | string | ✓ | The ID of the agent event, as returned by the POST /{entity_id}/agent_event endpoint. |

### Responses

**200**

The current status of the agent event.

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelAgentEventStatusResponse](#bizaiomnichannelagenteventstatusresponse)

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

**404**

Not found

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

Send an agent event

Trigger an agent action asynchronously. The event is enqueued for processing and the endpoint returns immediately with status "accepted".


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |

### Request Body (Required)

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelAgentEventRequest](#bizaiomnichannelagenteventrequest)

### Responses

**200**

Acknowledgment that the event was accepted for processing.


**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelAgentEventResponse](#bizaiomnichannelagenteventresponse)

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

<jumplink id="bizaiomnichannelagenteventrequest"></jumplink>
### BizAIOmniChannelAgentEventRequest

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| to | string | ✓ | Consumer phone number in E.164 format. |
| event | [Event](#object-event-1) | ✓ | Event-specific fields. |

<jumplink id="bizaiomnichannelagenteventresponse"></jumplink>
### BizAIOmniChannelAgentEventResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| status | string | ✓ | "accepted" when the event is successfully enqueued. |
| agent_event_id | string |  | The ID of the recorded agent event, when one was created. |

<jumplink id="standarderror"></jumplink>
### StandardError

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| title | string | ✓ |  |
| detail | string | ✓ |  |
| type | string |  |  |
| status | integer |  |  |

<jumplink id="bizaiomnichannelagenteventstatusresponse"></jumplink>
### BizAIOmniChannelAgentEventStatusResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| status | One of "request_received", "processing", "sent", "failed", "skipped", "success" | ✓ | The current processing status of the agent event. One of "request_received", "processing", "skipped", "sent", "success", or "failed". |
| event_type | string | ✓ | The partner-defined event identifier supplied when the event was submitted, e.g. "document_verified". |
| error_message | string |  | Summary of failure, if event state is FAILED. |
| skipped_reason | string |  | Summary of skip reason, if event state is SKIPPED. |
| created_at | string | ✓ | The ISO 8601 timestamp at which the agent event was received. |
| updated_at | string | ✓ | The ISO 8601 timestamp at which the agent event status was last updated. |

## Inline Object Definitions

<jumplink id="object-event-1"></jumplink>
### Event

Event-specific fields.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| type | string | ✓ | Required. Partner-defined event identifier, e.g. "document_verified", "payment_received". Max 256 characters. |
| description | string | ✓ | Required. Human-readable description of the event, e.g. "User's identity document has been verified". Max 1024 characters. |
| payload | string | ✓ | Required. Opaque JSON string passed through to the agent as-is. Max 4096 characters. |

## Authentication

| Scheme | Type | Location |
|--------|------|----------|
| OAuthToken__Authorization | HTTP Bearer | Header: `Authorization` |

### Usage Examples

- **OAuthToken__Authorization**: Include `Authorization: Bearer your-token-here` in request headers

### Global Authentication Requirements

All endpoints require: OAuthToken__Authorization