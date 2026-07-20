## Base URL

| URL | Description |
|-----|-------------|
| https://api.facebook.com/{entity_id}/agent_config/faq |  |

## Authorization

This API requires:

any of the following
  - Capability: bizai_wa_enterprise_api_3p_access
  - Permission: whatsapp_business_messaging

## APIs

| Method | Endpoint |
|--------|----------|
| DELETE | [/{faq_id}](#delete-faq-id) |
| GET | [/](#get) |
| GET | [/{faq_id}](#get-faq-id) |
| POST | [/](#post) |
| PUT | [/{faq_id}](#put-faq-id) |

<jumplink id="delete-faq-id"></jumplink>
## DELETE /{faq_id}

Delete an FAQ

Delete a specific FAQ entry by its ID

### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| faq_id | string | ✓ | The unique identifier of the FAQ entry |

### Responses

**204**

FAQ entry successfully deleted

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

List FAQs

Retrieve a list of all FAQ entries for the specified entity


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

A list of all FAQ entries

**Content Type**: `application/json`

**Schema**: array of [BizAIOmniChannelKnowledgeFAQResponse](#bizaiomnichannelknowledgefaqresponse)

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


<jumplink id="get-faq-id"></jumplink>
## GET /{faq_id}

Get an FAQ

Retrieve a specific FAQ entry by its ID

### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| faq_id | string | ✓ | The unique identifier of the FAQ entry |

### Responses

**200**

The requested FAQ entry

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelKnowledgeFAQResponse](#bizaiomnichannelknowledgefaqresponse)

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

Create an FAQ

Create a new FAQ entry for the specified entity


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

**Schema**: [BizAIOmniChannelKnowledgeFAQRequest](#bizaiomnichannelknowledgefaqrequest)

### Responses

**201**

The newly created FAQ entry

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelKnowledgeFAQResponse](#bizaiomnichannelknowledgefaqresponse)

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


<jumplink id="put-faq-id"></jumplink>
## PUT /{faq_id}

Update an FAQ

Update a specific FAQ entry by its ID

### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| faq_id | string | ✓ | The unique identifier of the FAQ entry |

### Request Body (Required)

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelKnowledgeFAQRequest](#bizaiomnichannelknowledgefaqrequest)

### Responses

**200**

The updated FAQ entry

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelKnowledgeFAQResponse](#bizaiomnichannelknowledgefaqresponse)

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

<jumplink id="bizaiomnichannelknowledgefaqrequest"></jumplink>
### BizAIOmniChannelKnowledgeFAQRequest

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| question | string | ✓ | The FAQ question text. Write it as a natural question a customer would ask. Each FAQ should address a single, specific topic. For example, use "What is your return policy?" rather than "Returns, exchanges, and refunds" — the agent matches questions more accurately when they mirror how customers phrase them. |
| answer | string | ✓ | The FAQ answer text. Keep answers factual, concise, and self-contained. Include all the information needed to fully answer the question without requiring the customer to ask follow-ups. Avoid referencing other FAQ entries — the agent retrieves each entry independently. |
| metadata | [Metadata](#object-metadata-1) |  | Key-value metadata associated with this FAQ entry |

<jumplink id="bizaiomnichannelknowledgefaqresponse"></jumplink>
### BizAIOmniChannelKnowledgeFAQResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| id | string | ✓ | The unique identifier for this FAQ entry |
| question | string | ✓ | The FAQ question text |
| answer | string | ✓ | The FAQ answer text |
| created_at | integer |  | The timestamp when the FAQ was created |
| metadata | [Metadata](#object-metadata-1) |  | Key-value metadata associated with this FAQ entry |

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

Key-value metadata associated with this FAQ entry


**Additional Properties**: string

## Authentication

| Scheme | Type | Location |
|--------|------|----------|
| OAuthToken__Authorization | HTTP Bearer | Header: `Authorization` |

### Usage Examples

- **OAuthToken__Authorization**: Include `Authorization: Bearer your-token-here` in request headers

### Global Authentication Requirements

All endpoints require: OAuthToken__Authorization