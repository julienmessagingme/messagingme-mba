## Base URL

| URL | Description |
|-----|-------------|
| https://api.facebook.com/{entity_id}/agent_config/business_info |  |

## Authorization

This API requires:

any of the following
  - Capability: bizai_wa_enterprise_api_3p_access
  - Permission: whatsapp_business_messaging

## APIs

| Method | Endpoint |
|--------|----------|
| DELETE | [/](#delete) |
| GET | [/](#get) |
| PUT | [/](#put) |

<jumplink id="delete"></jumplink>
## DELETE /

Reset business information to defaults

Reset the business information for the specified entity to default values. Returns the default (empty) business info object.


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

The default business information after reset


**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelKnowledgeBusinessInfoResponse](#bizaiomnichannelknowledgebusinessinforesponse)

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

Get business information

Retrieve the current business information for the specified entity. Returns empty/default values if none has been configured.


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

The current business information for the entity


**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelKnowledgeBusinessInfoResponse](#bizaiomnichannelknowledgebusinessinforesponse)

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

Create or replace business information

Create or fully replace the business information for the specified entity. All provided fields will overwrite existing values.


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

**Schema**: [BizAIOmniChannelKnowledgeBusinessInfoRequest](#bizaiomnichannelknowledgebusinessinforequest)

### Responses

**200**

The updated business information for the entity


**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelKnowledgeBusinessInfoResponse](#bizaiomnichannelknowledgebusinessinforesponse)

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

<jumplink id="bizaiomnichannelknowledgecontactinfo"></jumplink>
### BizAIOmniChannelKnowledgeContactInfo

Contact and location details for the business. Null if not configured


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| email | string |  | Business email address |
| hours_of_operation | string |  | Business hours of operation |
| address | string |  | Physical address of the business |

<jumplink id="bizaiomnichannelknowledgebusinessinforesponse"></jumplink>
### BizAIOmniChannelKnowledgeBusinessInfoResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| payment_method | string |  | Accepted payment methods |
| return_policy | string |  | The company return policy |
| purchase_info | string |  | Information about how to make a purchase |
| delivery_and_shipping | string |  | Details about delivery and shipping |
| business_description | string |  | General information about the business |
| contact_info | [BizAIOmniChannelKnowledgeContactInfo](#bizaiomnichannelknowledgecontactinfo) |  |  |

<jumplink id="standarderror"></jumplink>
### StandardError

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| title | string | ✓ |  |
| detail | string | ✓ |  |
| type | string |  |  |
| status | integer |  |  |

<jumplink id="bizaiomnichannelknowledgebusinessinforequest"></jumplink>
### BizAIOmniChannelKnowledgeBusinessInfoRequest

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| payment_method | string |  | Accepted payment methods |
| return_policy | string |  | The company return policy |
| purchase_info | string |  | Information about how to make a purchase |
| delivery_and_shipping | string |  | Details about delivery and shipping |
| business_description | string |  | General information about the business |
| contact_info | [BizAIOmniChannelKnowledgeContactInfo](#bizaiomnichannelknowledgecontactinfo) |  |  |

## Authentication

| Scheme | Type | Location |
|--------|------|----------|
| OAuthToken__Authorization | HTTP Bearer | Header: `Authorization` |

### Usage Examples

- **OAuthToken__Authorization**: Include `Authorization: Bearer your-token-here` in request headers

### Global Authentication Requirements

All endpoints require: OAuthToken__Authorization