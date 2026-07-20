
## Base URL

| URL | Description |
|-----|-------------|
| https://api.facebook.com/{entity_id}/agent_config/websites |  |

## Authorization

This API requires:

any of the following
  - Capability: bizai_wa_enterprise_api_3p_access
  - Permission: whatsapp_business_messaging

## APIs

| Method | Endpoint |
|--------|----------|
| DELETE | [/{website_id}](#delete-website-id) |
| GET | [/](#get) |
| GET | [/{website_id}](#get-website-id) |
| POST | [/](#post) |
| PUT | [/{website_id}](#put-website-id) |

<jumplink id="delete-website-id"></jumplink>
## DELETE /{website_id}

Delete a knowledge website

Delete a specific website crawl entry from the knowledge base by its ID


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| website_id | string | ✓ | The unique identifier of the website crawl entry |

### Responses

**204**

Website crawl entry successfully deleted

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


<jumplink id="get"></jumplink>
## GET /

List knowledge websites

Retrieve a list of all website URLs configured for AI agent knowledge crawling


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

A list of all website crawl entries

**Content Type**: `application/json`

**Schema**: array of [BizAIKnowledgeWebsiteResponse](#bizaiknowledgewebsiteresponse)

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


<jumplink id="get-website-id"></jumplink>
## GET /{website_id}

Get a knowledge website

Retrieve a specific website crawl entry by its ID


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| website_id | string | ✓ | The unique identifier of the website crawl entry |

### Responses

**200**

The requested website crawl entry

**Content Type**: `application/json`

**Schema**: [BizAIKnowledgeWebsiteResponse](#bizaiknowledgewebsiteresponse)

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


<jumplink id="post"></jumplink>
## POST /

Add a knowledge website

Add a new website URL for the AI agent to crawl and ingest into its knowledge base


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

**Schema**: [BizAIKnowledgeWebsiteRequest](#bizaiknowledgewebsiterequest)

### Responses

**201**

The newly created website crawl entry

**Content Type**: `application/json`

**Schema**: [BizAIKnowledgeWebsiteResponse](#bizaiknowledgewebsiteresponse)

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


<jumplink id="put-website-id"></jumplink>
## PUT /{website_id}

Update a knowledge website

Update a specific website crawl entry by its ID


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| website_id | string | ✓ | The unique identifier of the website crawl entry |

### Request Body (Required)

**Content Type**: `application/json`

**Schema**: [BizAIKnowledgeWebsiteRequest](#bizaiknowledgewebsiterequest)

### Responses

**200**

The updated website crawl entry

**Content Type**: `application/json`

**Schema**: [BizAIKnowledgeWebsiteResponse](#bizaiknowledgewebsiteresponse)

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

<jumplink id="bizaiknowledgewebsiterequest"></jumplink>
### BizAIKnowledgeWebsiteRequest

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| url | string | ✓ | The URL of the website to crawl |

<jumplink id="bizaiknowledgewebsiteresponse"></jumplink>
### BizAIKnowledgeWebsiteResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| id | string | ✓ | The unique identifier for this website crawl entry |
| url | string | ✓ | The URL of the website being crawled |
| crawl_status | string |  | The current status of the crawl (e.g., "pending", "in_progress", "completed", "failed") |
| pages_crawled | integer |  | The number of pages successfully crawled |
| last_crawled_at | integer |  | The timestamp when the website was last successfully crawled |
| created_at | integer |  | The timestamp when the website entry was created |

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