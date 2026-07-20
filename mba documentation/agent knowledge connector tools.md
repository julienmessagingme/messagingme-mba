## Base URL

| URL | Description |
|-----|-------------|
| https://api.facebook.com/{entity_id}/agent_connectors/{connector_id}/tools |  |

## Authorization

This API requires:

any of the following
  - Capability: bizai_wa_enterprise_api_3p_access
  - Permission: whatsapp_business_messaging

## APIs

| Method | Endpoint |
|--------|----------|
| DELETE | [/{tool_id}](#delete-tool-id) |
| GET | [/](#get) |
| GET | [/{tool_id}](#get-tool-id) |
| POST | [/](#post) |
| POST | [/{tool_id}/run](#post-tool-id-run) |
| PUT | [/{tool_id}](#put-tool-id) |

<jumplink id="delete-tool-id"></jumplink>
## DELETE /{tool_id}

Delete a connector tool

Delete a specific tool by its ID

### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| connector_id | string | ✓ | The unique identifier of the parent connector |
| tool_id | string | ✓ | The unique identifier of the tool |

### Responses

**204**

Tool successfully deleted

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

List connector tools

Retrieve a list of all tools for the specified connector


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| connector_id | string | ✓ | The unique identifier of the parent connector |

### Responses

**200**

A list of all tools

**Content Type**: `application/json`

**Schema**: array of [BizAIOmniChannelConnectorToolResponse](#bizaiomnichannelconnectortoolresponse)

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


<jumplink id="get-tool-id"></jumplink>
## GET /{tool_id}

Get a connector tool

Retrieve a specific tool by its ID

### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| connector_id | string | ✓ | The unique identifier of the parent connector |
| tool_id | string | ✓ | The unique identifier of the tool |

### Responses

**200**

The requested tool

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorToolResponse](#bizaiomnichannelconnectortoolresponse)

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

Create a connector tool

Create a new tool for the specified connector


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| connector_id | string | ✓ | The unique identifier of the parent connector |

### Request Body (Required)

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorToolRequest](#bizaiomnichannelconnectortoolrequest)

### Responses

**201**

The newly created tool

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorToolResponse](#bizaiomnichannelconnectortoolresponse)

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


<jumplink id="post-tool-id-run"></jumplink>
## POST /{tool_id}/run

Run a connector tool

Execute a tool action. Returns the raw response from the upstream API endpoint.


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| connector_id | string | ✓ | The unique identifier of the parent connector |
| tool_id | string | ✓ | The unique identifier of the tool |

### Request Body (Required)

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorToolRunRequest](#bizaiomnichannelconnectortoolrunrequest)

### Responses

**200**

The tool execution result

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorToolRunResponse](#bizaiomnichannelconnectortoolrunresponse)

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


<jumplink id="put-tool-id"></jumplink>
## PUT /{tool_id}

Update a connector tool

Update a specific tool by its ID

### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| connector_id | string | ✓ | The unique identifier of the parent connector |
| tool_id | string | ✓ | The unique identifier of the tool |

### Request Body (Required)

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorToolRequest](#bizaiomnichannelconnectortoolrequest)

### Responses

**200**

The updated tool

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorToolResponse](#bizaiomnichannelconnectortoolresponse)

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

<jumplink id="bizaiomnichannelconnectortoolparameterbinding"></jumplink>
### BizAIOmniChannelConnectorToolParameterBinding

Meta Business Agent-owned binding for this node; omitted means agent/runtime input at the node’s canonical path. This cannot be provided for an "object" or "array" type node


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| kind | One of "default", "macro" | ✓ | Source mode for a Meta Business Agent-owned field. |
| value | string |  | Typed literal value, required when `kind = "default"`; It must be provided as a string, and the underlying value must match the node type. It will be converted into the appropriate node type when making toolcalls to the underlying endpoint. |
| macro | One of "WHATSAPP_PHONE_NUMBER", "WHATSAPP_IDENTITY_HASH", "WHATSAPP_CURRENT_STATUS_ID" |  | Registered Meta Business Agent macro ID, required when `kind = "macro"`. |

<jumplink id="bizaiomnichannelconnectortoolparameternode"></jumplink>
### BizAIOmniChannelConnectorToolParameterNode

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| type | One of "string", "integer", "number", "boolean" | ✓ | Node type. |
| description | string |  | Human-readable documentation for the parameter. Always provide a description — the agent uses it to understand what value to extract from the conversation and pass to the API. |
| required | boolean |  | Whether the field is required. This field is ignored for path params, since they are always required. |
| binding | [BizAIOmniChannelConnectorToolParameterBinding](#bizaiomnichannelconnectortoolparameterbinding) |  |  |

<jumplink id="bizaiomnichannelconnectortoolbodynode"></jumplink>
### BizAIOmniChannelConnectorToolBodyNode

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| type | One of "object", "array", "string", "integer", "number", "boolean" | ✓ | Node type. When defining a field that contains structured data, use `object` with explicit `properties` rather than `string`. Fully defined schemas allow the agent to extract and pass the correct fields automatically. Avoid using `object` without defining its `properties`, as this causes the agent to guess the expected structure. |
| description | string |  | Human-readable documentation for the field or container. Always provide a description for every node — the agent uses it to understand what data each field expects and to extract the right values from the conversation. |
| required | array of string |  | Required properties of this object. It can only be provided for "object" type nodes. |
| properties | [Properties](#object-properties-1) |  | Child fields for `object` nodes; keys are canonical outbound field names, value is a string representation of the BodyNode type. Only provide when node is of type `object`. Always define explicit properties with their types and descriptions instead of leaving an object undefined — the agent needs a fully specified schema to correctly populate the request. |
| items | string |  | BodyNode element schema for `array` nodes. Only provide when node is of type `array`. This field needs to be provided as a string representation of the BodyNode type. |
| binding | [BizAIOmniChannelConnectorToolParameterBinding](#bizaiomnichannelconnectortoolparameterbinding) |  |  |

<jumplink id="bizaiomnichannelconnectortoolrequestbodydefinition"></jumplink>
### BizAIOmniChannelConnectorToolRequestBodyDefinition

Request body definition; omit or set to `null` when the request has no body.


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| content_type | "application/json" | ✓ | Request body content type; currently only supports `application/json` |
| params | [Params](#object-params-2) | ✓ | Top-level JSON body fields; keys are canonical outbound field names. |
| required | array of string |  | Required top-level body fields. Entries must be keys present in `params`. |

<jumplink id="bizaiomnichannelconnectortoolrequestdefinition"></jumplink>
### BizAIOmniChannelConnectorToolRequestDefinition

Roundtripped outbound HTTP request definition.


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| method | One of "GET", "POST", "PUT", "DELETE", "PATCH" | ✓ | HTTP method for the outbound request. |
| path | string | ✓ | Outbound request path template, including `{placeholder}` segments for path parameters. |
| path_parameters | [Path_parameters](#object-path_parameters-3) |  | Path-parameter schema; property names must match the placeholder names used in `path`. |
| query_parameters | [Query_parameters](#object-query_parameters-4) |  | Query-parameter schema; property names are the canonical outbound query parameter names. |
| headers | [Headers](#object-headers-5) |  | Header schema; property names are the canonical outbound header names. |
| body | [BizAIOmniChannelConnectorToolRequestBodyDefinition](#bizaiomnichannelconnectortoolrequestbodydefinition) |  |  |

<jumplink id="bizaiomnichannelconnectortooluserauthtoolconfig"></jumplink>
### BizAIOmniChannelConnectorToolUserAuthToolConfig

Response extraction config for login/refresh user-auth actions.


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| user_action_tool_type | One of "auth", "refresh" | ✓ | Type of user auth action: auth performs the initial user authorization, while refresh uses an existing refresh token. |
| user_auth_token_path | string | ✓ | Dot-path used to extract the access token from a login/refresh tool response. |
| refresh_token_path | string |  | Dot-path used to extract the refresh token from a login/refresh tool response. |
| expires_at_path | string |  | Dot-path used to extract token expiry from a login/refresh tool response. |
| expires_at_type | One of "absolute", "relative_seconds" |  | How to interpret the value found at `expires_at_path`. |

<jumplink id="bizaiomnichannelconnectortoolrequest"></jumplink>
### BizAIOmniChannelConnectorToolRequest

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| name | string | ✓ | Stable tool/action key, visible to the agent. Use a clear, descriptive name that indicates the action (e.g., `check_order_status`, `create_return_request`). Avoid generic names like `action1` or `tool`. |
| description | string | ✓ | Human-readable description of what this tool does and when to use it. The agent relies on this description to decide when to invoke the tool during a conversation. Be specific about the action, expected inputs, and what the tool returns. For example: "Use this tool when a customer asks about the status of an existing order. Requires an order ID. Returns the order status, estimated delivery date, and tracking information." Vague or missing descriptions cause the agent to invoke tools incorrectly or not at all. |
| request_definition | [BizAIOmniChannelConnectorToolRequestDefinition](#bizaiomnichannelconnectortoolrequestdefinition) | ✓ |  |
| user_auth_required | boolean | ✓ | If `true`, Meta Business Agent injects stored user auth into the outbound request at runtime using the connector's user-auth injection config. |
| user_auth_action_config | [BizAIOmniChannelConnectorToolUserAuthToolConfig](#bizaiomnichannelconnectortooluserauthtoolconfig) |  |  |

<jumplink id="bizaiomnichannelconnectortooluserauthactionconfig"></jumplink>
### BizAIOmniChannelConnectorToolUserAuthActionConfig

Response extraction config for login/refresh user-auth actions.


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| user_action_tool_type | One of "auth", "refresh" | ✓ | Type of user auth action: auth performs the initial user authorization, while refresh uses an existing refresh token. |
| user_auth_token_path | string | ✓ | Dot-path used to extract the access token from a login/refresh tool response. |
| refresh_token_path | string |  | Dot-path used to extract the refresh token from a login/refresh tool response. |
| expires_at_path | string |  | Dot-path used to extract token expiry from a login/refresh tool response. |
| expires_at_type | One of "absolute", "relative_seconds" |  | How to interpret the value found at `expires_at_path`. |

<jumplink id="bizaiomnichannelconnectortoolresponse"></jumplink>
### BizAIOmniChannelConnectorToolResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| id | string | ✓ | Tool ID returned by the Stefi API. |
| name | string | ✓ | Stable tool/action key, visible to the agent. |
| description | string | ✓ | Human-readable tool description. |
| request_definition | [BizAIOmniChannelConnectorToolRequestDefinition](#bizaiomnichannelconnectortoolrequestdefinition) | ✓ |  |
| user_auth_required | boolean | ✓ | Whether Meta Business Agent injects stored user auth into the outbound request at runtime. |
| user_auth_action_config | [BizAIOmniChannelConnectorToolUserAuthActionConfig](#bizaiomnichannelconnectortooluserauthactionconfig) |  |  |

<jumplink id="standarderror"></jumplink>
### StandardError

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| title | string | ✓ |  |
| detail | string | ✓ |  |
| type | string |  |  |
| status | integer |  |  |

<jumplink id="bizaiomnichannelconnectortoolrunrequest"></jumplink>
### BizAIOmniChannelConnectorToolRunRequest

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| input | string |  | JSON-encoded input payload for the tool action. Defaults to empty object if not provided. |

<jumplink id="bizaiomnichannelconnectortoolrunresponse"></jumplink>
### BizAIOmniChannelConnectorToolRunResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| output | string | ✓ | JSON-encoded response from the tool execution |
| status | string | ✓ | Execution status: success or error |

## Inline Object Definitions

<jumplink id="object-properties-1"></jumplink>
### Properties

Child fields for `object` nodes; keys are canonical outbound field names, value is a string representation of the BodyNode type. Only provide when node is of type `object`. Always define explicit properties with their types and descriptions instead of leaving an object undefined — the agent needs a fully specified schema to correctly populate the request.


**Additional Properties**: string

<jumplink id="object-params-2"></jumplink>
### Params

Top-level JSON body fields; keys are canonical outbound field names.


**Additional Properties**: [BizAIOmniChannelConnectorToolBodyNode](#bizaiomnichannelconnectortoolbodynode)

<jumplink id="object-path_parameters-3"></jumplink>
### Path_parameters

Path-parameter schema; property names must match the placeholder names used in `path`.


**Additional Properties**: [BizAIOmniChannelConnectorToolParameterNode](#bizaiomnichannelconnectortoolparameternode)

<jumplink id="object-query_parameters-4"></jumplink>
### Query_parameters

Query-parameter schema; property names are the canonical outbound query parameter names.


**Additional Properties**: [BizAIOmniChannelConnectorToolParameterNode](#bizaiomnichannelconnectortoolparameternode)

<jumplink id="object-headers-5"></jumplink>
### Headers

Header schema; property names are the canonical outbound header names.


**Additional Properties**: [BizAIOmniChannelConnectorToolParameterNode](#bizaiomnichannelconnectortoolparameternode)

## Authentication

| Scheme | Type | Location |
|--------|------|----------|
| OAuthToken__Authorization | HTTP Bearer | Header: `Authorization` |

### Usage Examples

- **OAuthToken__Authorization**: Include `Authorization: Bearer your-token-here` in request headers

### Global Authentication Requirements

All endpoints require: OAuthToken__Authorization