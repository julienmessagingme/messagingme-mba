## Base URL

| URL | Description |
|-----|-------------|
| https://api.facebook.com/{entity_id}/agent_connectors |  |

## Authorization

This API requires:

any of the following
  - Capability: bizai_wa_enterprise_api_3p_access
  - Permission: whatsapp_business_messaging

## APIs

| Method | Endpoint |
|--------|----------|
| DELETE | [/{connector_id}](#delete-connector-id) |
| GET | [/](#get) |
| GET | [/{connector_id}](#get-connector-id) |
| GET | [/{connector_id}/logs](#get-connector-id-logs) |
| POST | [/](#post) |
| POST | [/{connector_id}/upsertApiKey](#post-connector-id-upsertapikey) |
| POST | [/{connector_id}/upsertCertificate](#post-connector-id-upsertcertificate) |
| POST | [/{connector_id}/upsertOAuth](#post-connector-id-upsertoauth) |
| PUT | [/{connector_id}](#put-connector-id) |

<jumplink id="delete-connector-id"></jumplink>
## DELETE /{connector_id}

Delete a connector

Delete a specific connector by its ID

### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| connector_id | string | ✓ | The unique identifier of the connector |

### Responses

**204**

Connector successfully deleted

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

List connectors

Retrieve a list of all connectors for the specified entity


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

A list of all connectors

**Content Type**: `application/json`

**Schema**: array of [BizAIOmniChannelConnectorResponse](#bizaiomnichannelconnectorresponse)

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


<jumplink id="get-connector-id"></jumplink>
## GET /{connector_id}

Get a connector

Retrieve a specific connector by its ID

### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| connector_id | string | ✓ | The unique identifier of the connector |

### Responses

**200**

The requested connector

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorResponse](#bizaiomnichannelconnectorresponse)

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


<jumplink id="get-connector-id-logs"></jumplink>
## GET /{connector_id}/logs

List connector error logs

Retrieve error logs for the connector. Returns individual log entries by default, or aggregated failure patterns ranked by occurrence count when summary_only is true. Optionally includes aggregate statistics such as success rate and latency percentiles. Only errors originating from the third-party system are included. The time range (end_time - start_time) must not exceed 7 days. Logs are available for the last 7 days only.

### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| connector_id | string | ✓ | The unique identifier of the connector |

### Query Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| start_time | integer |  | Start of the time range as a Unix timestamp (seconds). Defaults to 24 hours ago. Must be within the last 7 days. The time range must not exceed 7 days. |
| end_time | integer |  | End of the time range as a Unix timestamp (seconds). Defaults to now (server side). The time range must not exceed 7 days. |
| limit | integer |  | Maximum number of log entries to return (1-1000). Defaults to 100. |
| tool_id | string |  | Optional tool ID to filter logs to a specific operation. When omitted, returns logs for all tools on the connector. |
| include_stats | boolean |  | When true, include aggregate statistics (success rate, latency percentiles, counts) in the response. The returned `time_window_seconds` reflects the actual covered window, which may be smaller than your requested range if the most recent logs have not yet been processed. Defaults to false. |
| summary_only | boolean |  | When true, return aggregated failure patterns ranked by occurrence count instead of individual log entries. Defaults to false. |
| top_n | integer |  | Number of top failure patterns to return when summary_only is true (1-50). Defaults to 10. |

### Responses

**200**

Log entries or failure patterns, with optional statistics


**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorLogStatsResponse](#bizaiomnichannelconnectorlogstatsresponse)

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

Create a connector

Create a new connector for the specified entity


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

**Schema**: [BizAIOmniChannelConnectorRequest](#bizaiomnichannelconnectorrequest)

### Responses

**201**

The newly created connector

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorResponse](#bizaiomnichannelconnectorresponse)

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


<jumplink id="post-connector-id-upsertapikey"></jumplink>
## POST /{connector_id}/upsertApiKey

Upsert API key credentials for a connector


Set or rotate the API key credentials for this connector. If credentials already exist, they are replaced and the connection is re-established with the new credentials. The credential payload is required; this endpoint will not delete credentials. To remove an API key layer, delete the connector or change its auth type via the update endpoint instead.


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| connector_id | string | ✓ | The unique identifier of the connector |

### Request Body (Required)

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorUpsertApiKeyRequest](#bizaiomnichannelconnectorupsertapikeyrequest)

### Responses

**200**

The updated connector with API key metadata


**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorResponse](#bizaiomnichannelconnectorresponse)

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


<jumplink id="post-connector-id-upsertcertificate"></jumplink>
## POST /{connector_id}/upsertCertificate

Upsert mTLS certificate for a connector

Upload or rotate the mTLS client certificate for this connector. If a certificate already exists, it will be replaced and the connection will be re-established with the new credentials.


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| connector_id | string | ✓ | The unique identifier of the connector |

### Request Body (Required)

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorCertificateRequest](#bizaiomnichannelconnectorcertificaterequest)

### Responses

**200**

The updated connector with mTLS certificate metadata


**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorResponse](#bizaiomnichannelconnectorresponse)

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


<jumplink id="post-connector-id-upsertoauth"></jumplink>
## POST /{connector_id}/upsertOAuth

Upsert OAuth 2.0 credentials for a connector


Set or rotate the OAuth 2.0 client credentials for this connector. If credentials already exist, they are replaced and the connection is re-established with the new credentials. The credential payload is required; this endpoint will not delete credentials. To remove an OAuth layer, delete the connector or change its auth type via the update endpoint instead.


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| connector_id | string | ✓ | The unique identifier of the connector |

### Request Body (Required)

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorUpsertOAuthRequest](#bizaiomnichannelconnectorupsertoauthrequest)

### Responses

**200**

The updated connector with OAuth credential metadata


**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorResponse](#bizaiomnichannelconnectorresponse)

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


<jumplink id="put-connector-id"></jumplink>
## PUT /{connector_id}

Update a connector

Update a specific connector by its ID

### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| connector_id | string | ✓ | The unique identifier of the connector |

### Request Body (Required)

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorRequest](#bizaiomnichannelconnectorrequest)

### Responses

**200**

The updated connector

**Content Type**: `application/json`

**Schema**: [BizAIOmniChannelConnectorResponse](#bizaiomnichannelconnectorresponse)

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

<jumplink id="bizaiomnichannelconnectoroauth2clientcredentialsauthconfig"></jumplink>
### BizAIOmniChannelConnectorOAuth2ClientCredentialsAuthConfig

OAuth 2.0 client credentials configuration. Provide this only when auth_type is OAUTH2_CLIENT_CREDENTIALS.


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| token_url | string | ✓ | Token URL used to request OAuth access tokens. |
| scopes_to_request | array of string | ✓ | OAuth scopes to request. |
| token_request_content_type | string |  | Content type for token requests. Supported values are application/x-www-form-urlencoded and application/json. Defaults to application/x-www-form-urlencoded. |
| client_id | string | ✓ | OAuth client ID. |
| client_secret | string | ✓ | OAuth client secret. |

<jumplink id="bizaiomnichannelconnectorapikeyparam"></jumplink>
### BizAIOmniChannelConnectorApiKeyParam

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| field_name | string | ✓ | Header, query parameter, or body field name. |
| value | string | ✓ | Secret value for this API key field. |
| prefix | string |  | Optional value prefix, such as Bearer followed by a space. |

<jumplink id="bizaiomnichannelconnectorapikeyauthconfig"></jumplink>
### BizAIOmniChannelConnectorApiKeyAuthConfig

API key configuration. Provide this only when auth_type is API_KEY.


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| headers | array of [BizAIOmniChannelConnectorApiKeyParam](#bizaiomnichannelconnectorapikeyparam) |  | API key fields to add as HTTP headers. |
| query_params | array of [BizAIOmniChannelConnectorApiKeyParam](#bizaiomnichannelconnectorapikeyparam) |  | API key fields to add as query parameters. |
| body_params | array of [BizAIOmniChannelConnectorApiKeyParam](#bizaiomnichannelconnectorapikeyparam) |  | API key fields to add as JSON body parameters. |

<jumplink id="bizaiomnichannelconnectorauthconfig"></jumplink>
### BizAIOmniChannelConnectorAuthConfig

Authentication configuration for this connector


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| oauth2_client_credentials | [BizAIOmniChannelConnectorOAuth2ClientCredentialsAuthConfig](#bizaiomnichannelconnectoroauth2clientcredentialsauthconfig) |  |  |
| api_key | [BizAIOmniChannelConnectorApiKeyAuthConfig](#bizaiomnichannelconnectorapikeyauthconfig) |  |  |

<jumplink id="bizaiomnichannelconnectorrequest"></jumplink>
### BizAIOmniChannelConnectorRequest

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| name | string | ✓ | Display name of the connector. Use a name that clearly identifies the external service (e.g., `Shopify Order Management`, `Salesforce CRM`). |
| description | string | ✓ | Description of what this connector integrates with and its purpose. The agent uses this to understand the connector's capabilities. For example: "Connects to the Shopify API for managing customer orders, processing returns, and checking inventory availability." |
| base_url | string | ✓ | Base URL of the external API |
| auth_type | One of "OAUTH2", "OAUTH2_CLIENT_CREDENTIALS", "API_KEY", "BASIC", "CUSTOM", "NONE" | ✓ | Authentication type for this connector. Currently, only OAUTH2_CLIENT_CREDENTIALS, API_KEY, and NONE are supported. |
| auth_config | [BizAIOmniChannelConnectorAuthConfig](#bizaiomnichannelconnectorauthconfig) |  |  |
| user_auth_injection_config | [User_auth_injection_config](#object-user_auth_injection_config-1) |  | Configuration for injecting user auth tokens into tool requests |
| requires_certificate | boolean |  | Whether this connector requires mTLS client certificate. When true, use the upsert_certificate endpoint to provide the cert. |

<jumplink id="bizaiomnichannelconnectorresponse"></jumplink>
### BizAIOmniChannelConnectorResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| id | string | ✓ | The unique identifier for this connector |
| name | string | ✓ | Display name of the connector |
| description | string | ✓ | Description of the connector |
| base_url | string | ✓ | Base URL of the external API |
| auth_type | One of "OAUTH2", "OAUTH2_CLIENT_CREDENTIALS", "API_KEY", "BASIC", "CUSTOM", "NONE" | ✓ | Authentication type for this connector |
| auth_config | [BizAIOmniChannelConnectorAuthConfig](#bizaiomnichannelconnectorauthconfig) |  |  |
| mtls_config | [Mtls_config](#object-mtls_config-2) |  | mTLS certificate metadata and PEM content (private key is never exposed) |
| connection_status | [Connection_status](#object-connection_status-3) | ✓ | Connection status information |
| user_auth_injection_config | [User_auth_injection_config](#object-user_auth_injection_config-4) |  | Configuration for injecting user auth tokens into tool requests |

<jumplink id="standarderror"></jumplink>
### StandardError

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| title | string | ✓ |  |
| detail | string | ✓ |  |
| type | string |  |  |
| status | integer |  |  |

<jumplink id="bizaiomnichannelconnectorcertificaterequest"></jumplink>
### BizAIOmniChannelConnectorCertificateRequest

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| client_certificate | string | ✓ | PEM-encoded client certificate for mTLS authentication. Must begin with "-----BEGIN CERTIFICATE-----". |
| client_key | string | ✓ | PEM-encoded private key for mTLS authentication. Must begin with "-----BEGIN PRIVATE KEY-----" (PKCS8), "-----BEGIN RSA PRIVATE KEY-----", or "-----BEGIN EC PRIVATE KEY-----". |
| ca_certificate | string |  | Optional PEM-encoded CA certificate for the client side mTLS trust chain to verify server side certificate. Useful if server certificate is not signed by a public CA. |

<jumplink id="bizaiomnichannelconnectorupsertapikeyrequest"></jumplink>
### BizAIOmniChannelConnectorUpsertApiKeyRequest

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| api_key_config | [BizAIOmniChannelConnectorApiKeyAuthConfig](#bizaiomnichannelconnectorapikeyauthconfig) | ✓ |  |

<jumplink id="bizaiomnichannelconnectorupsertoauthrequest"></jumplink>
### BizAIOmniChannelConnectorUpsertOAuthRequest

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| oauth_config | [BizAIOmniChannelConnectorOAuth2ClientCredentialsAuthConfig](#bizaiomnichannelconnectoroauth2clientcredentialsauthconfig) | ✓ |  |

<jumplink id="bizaiomnichannelconnectorlogstatsresponse"></jumplink>
### BizAIOmniChannelConnectorLogStatsResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| data | array of [Data](#object-data-5) | ✓ | Array of log entries or failure patterns depending on query mode |
| stats | [Stats](#object-stats-6) |  | Aggregate statistics for the queried time window, present when include_stats is true |

## Inline Object Definitions

<jumplink id="object-user_auth_injection_config-1"></jumplink>
### User_auth_injection_config

Configuration for injecting user auth tokens into tool requests


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| location | One of "body", "headers", "path", "query" | ✓ | Where to inject the token (HEADERS, QUERY, or BODY) |
| field_name | string | ✓ | Field name for the injected token (e.g., "X-User-Token") |
| prefix | string | ✓ | Prefix for the token value (e.g., "Bearer ") |

<jumplink id="object-mtls_config-2"></jumplink>
### Mtls_config

mTLS certificate metadata and PEM content (private key is never exposed)


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| has_certificate | boolean | ✓ | Whether an mTLS certificate is configured |
| fingerprint | string |  | SHA-256 fingerprint of the certificate |
| expires_at | integer |  | Unix timestamp of certificate expiry |
| subject | string |  | Certificate subject DN |
| client_certificate | string |  | PEM-encoded client certificate (public, safe to expose) |
| ca_certificate | string |  | PEM-encoded CA certificate chain (public, safe to expose) |

<jumplink id="object-connection_status-3"></jumplink>
### Connection_status

Connection status information

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| status | One of "PENDING_OAUTH", "ACTIVE", "EXPIRED", "ERROR" | ✓ | Current connection status |
| error_message | string |  | Error message if connection failed |

<jumplink id="object-user_auth_injection_config-4"></jumplink>
### User_auth_injection_config

Configuration for injecting user auth tokens into tool requests


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| location | One of "body", "headers", "path", "query" | ✓ | Where to inject the token |
| field_name | string | ✓ | Field name for the injected token |
| prefix | string | ✓ | Prefix for the token value |

<jumplink id="object-data-5"></jumplink>
### Data

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| event_time | string |  | ISO 8601 UTC timestamp at second precision (e.g. "2026-05-13T21:46:58Z") of when the error event occurred (individual log entry mode). |
| failure_code_name | string |  | Human-readable name of the failure code (e.g. TRANSPORT_ERROR) |
| error_message | string |  | Error message from the failed operation |
| tool_name | string |  | The tool that was being used when the error occurred |
| occurrences | integer |  | Number of times this failure pattern occurred (summary_only mode) |
| last_seen | string |  | ISO 8601 UTC timestamp at second precision (e.g. "2026-05-13T21:46:58Z") of the most recent occurrence (summary_only mode). |

<jumplink id="object-stats-6"></jumplink>
### Stats

Aggregate statistics for the queried time window, present when include_stats is true


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| start_count | integer | ✓ | Total number of tool execution starts |
| success_count | integer | ✓ | Number of successful tool executions |
| exception_count | integer | ✓ | Number of failed tool executions |
| success_rate | number | ✓ | Ratio of successful executions to total starts |
| avg_latency_s | number | ✓ | Average execution latency in seconds |
| p95_latency_s | number | ✓ | 95th percentile execution latency in seconds |
| p99_latency_s | number | ✓ | 99th percentile execution latency in seconds |
| time_window_seconds | integer | ✓ | Number of seconds in the statistics time window. Reflects the actual covered window, which may be smaller than the requested range if the most recent logs have not yet been processed. |

## Authentication

| Scheme | Type | Location |
|--------|------|----------|
| OAuthToken__Authorization | HTTP Bearer | Header: `Authorization` |

### Usage Examples

- **OAuthToken__Authorization**: Include `Authorization: Bearer your-token-here` in request headers

### Global Authentication Requirements

All endpoints require: OAuthToken__Authorization