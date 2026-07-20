## Base URL

| URL | Description |
|-----|-------------|
| https://api.facebook.com/{entity_id}/agent-eval |  |

## Authorization

This API requires:

any of the following
  - Capability: bizai_wa_enterprise_api_3p_access
  - Permission: whatsapp_business_messaging

## APIs

| Method | Endpoint |
|--------|----------|
| GET | [/cases](#get-cases) |
| GET | [/details](#get-details) |
| GET | [/run](#get-run) |
| GET | [/summary](#get-summary) |
| POST | [/run](#post-run) |

<jumplink id="get-cases"></jumplink>
## GET /cases

List evaluation cases

List all evaluation scenario configurations for the given entity.


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The entity ID (e.g. WhatsApp Business phone number ID) |

### Responses

**200**

List of eval cases for the entity.

**Content Type**: `application/json`

**Schema**: object

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| eval_cases | array of [BizAIEvalCaseResponse](#bizaievalcaseresponse) | ✓ | Array of eval case configurations. |

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


<jumplink id="get-details"></jumplink>
## GET /details

Get evaluation details

Retrieve per-conversation evaluation results by evaluation IDs.


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The entity ID (e.g. WhatsApp Business phone number ID) |

### Query Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| eval_ids | string | ✓ | Comma-separated list of evaluation IDs to retrieve |

### Responses

**200**

The requested evaluations.

**Content Type**: `application/json`

**Schema**: object

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| evaluations | array of [BizAIEvalDetailResponse](#bizaievaldetailresponse) | ✓ | List of evaluation results. |

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


<jumplink id="get-run"></jumplink>
## GET /run

Get evaluation job status

Poll the status and results of a previously submitted evaluation job.


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The entity ID (e.g. WhatsApp Business phone number ID) |

### Query Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| job_id | string | ✓ | The job ID returned by the POST /run endpoint. |

### Responses

**200**

Current job status and results (if completed).


**Content Type**: `application/json`

**Schema**: [BizAIComboJobStatusResponse](#bizaicombojobstatusresponse)

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


<jumplink id="get-summary"></jumplink>
## GET /summary

Get evaluation summary

Retrieve aggregated insight reports for agent evaluations by insight IDs.


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The entity ID (e.g. WhatsApp Business phone number ID) |

### Query Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| summary_ids | string | ✓ | Comma-separated list of summary IDs to retrieve |

### Responses

**200**

List of insight reports.

**Content Type**: `application/json`

**Schema**: object

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| insights | array of [BizAIEvalSummaryResponse](#bizaievalsummaryresponse) | ✓ | Array of insight report objects. |

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


<jumplink id="post-run"></jumplink>
## POST /run

Run an evaluation job

Submit a combo evaluation job that runs simulation, evaluation, and optionally insights across multiple cases. Returns a job_id for polling.


### Header Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| X-API-Version | "2.0.0" |  |  |

### Path Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_id | string | ✓ | The entity ID (e.g. WhatsApp Business phone number ID) |

### Query Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| eval_case_ids | string | ✓ | Comma-separated list of eval case IDs (pfbid format). |

### Request Body (Required)

**Content Type**: `application/json`

**Schema**: [BizAIComboRunRequest](#bizaicomborunrequest)

### Responses

**200**

Acknowledgment that the job was accepted for processing.


**Content Type**: `application/json`

**Schema**: [BizAIComboRunResponse](#bizaicomborunresponse)

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

<jumplink id="bizaievalcaseresponse"></jumplink>
### BizAIEvalCaseResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| id | string | ✓ | The eval case ent ID. |
| scenario | string | ✓ | Free-form text defining the task and constraints for the user simulator. |
| categories | array of string |  | Category strings for the test scenario. |
| max_turns | integer |  | Maximum number of turns allowed in the conversation simulation. |
| success_criteria | array of string |  | Criteria strings the agent must meet for the test to pass. |

<jumplink id="standarderror"></jumplink>
### StandardError

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| title | string | ✓ |  |
| detail | string | ✓ |  |
| type | string |  |  |
| status | integer |  |  |

<jumplink id="bizaievalsummaryresponse"></jumplink>
### BizAIEvalSummaryResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| id | string | ✓ | The unique identifier for the insight report |
| avg_conversation_score | number |  | Average score across evaluated conversations |
| avg_turn_score | number |  | Average score across evaluated turns |
| summary | string | ✓ | Natural-language summary of overall agent performance |
| highlights | string |  | JSON array of highlight objects with description and evaluation IDs |
| top_failure_categories | string |  | JSON array of failure category objects with category, evaluation IDs, and recommended actions |
| eval_ids_by_score | string |  | JSON object grouping evaluation IDs by score |
| creation_time | integer | ✓ | Unix timestamp when the insight report was created |
| update_time | integer | ✓ | Unix timestamp when the insight report was last updated |

<jumplink id="bizaievaldetailresponse"></jumplink>
### BizAIEvalDetailResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| id | string | ✓ | The evaluation ID |
| score | integer |  | Overall evaluation score from the judge LLM |
| per_turn_labels | string | ✓ | JSON array of per-turn label integers |
| reasons | string | ✓ | JSON array of {category, score, description, recommended_actions} objects |
| custom_success_criteria | string |  | JSON array of client-specified success criteria strings |
| eval_case_id | string |  | ID of the eval case that defined the scenario and success criteria |
| transcript | string |  | JSON object with system_prompt and transcript_turns for the evaluated conversation |
| creation_time | integer | ✓ | Unix timestamp when the evaluation was created |
| update_time | integer | ✓ | Unix timestamp when the evaluation was last updated |

<jumplink id="bizaicomborunrequest"></jumplink>
### BizAIComboRunRequest

**Additional Properties**: Not allowed

<jumplink id="bizaicomborunresponse"></jumplink>
### BizAIComboRunResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| job_id | string | ✓ | The unique identifier for the created evaluation job (pfbid format). |
| status | string | ✓ | Initial job status: QUEUED. |

<jumplink id="bizaicombojobresult"></jumplink>
### BizAIComboJobResult

Full result payload when status is COMPLETED.


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| summary_id | string | ✓ | The unique identifier for the summary report |
| avg_conversation_score | number |  | Average score across evaluated conversations (range: 1-5) |
| avg_turn_score | number |  | Average score across evaluated turns, where a turn is a user-agent message pair. This is a finer-granularity score than avg_conversation_score (range: 1-5). |
| summary | string | ✓ | Natural-language summary of overall agent performance |
| highlights | string |  | JSON array of highlight objects with description and evaluation IDs |
| top_failure_categories | string |  | JSON array of failure category objects with category, evaluation IDs, and recommended actions |
| eval_ids_by_score | string |  | JSON object grouping evaluation IDs by score |
| creation_time | integer | ✓ | Unix timestamp when the insight report was created |
| update_time | integer | ✓ | Unix timestamp when the insight report was last updated |

<jumplink id="bizaicombojobstatusresponse"></jumplink>
### BizAIComboJobStatusResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| status | string | ✓ | Job status: QUEUED, RUNNING, COMPLETED, or FAILED. |
| progress | [Progress](#object-progress-1) |  | Progress information while the job is running. |
| result | [BizAIComboJobResult](#bizaicombojobresult) |  |  |
| error | [Error](#object-error-2) |  | Error details when status is FAILED. |

## Inline Object Definitions

<jumplink id="object-progress-1"></jumplink>
### Progress

Progress information while the job is running.


| Property | Type | Required | Description |
|----------|------|----------|-------------|
| completed | integer | ✓ | Number of eval cases completed. |
| total | integer | ✓ | Total number of eval cases in the job. |
| current_stage | string | ✓ | Current pipeline stage: simulation, evaluation, insights, or done. |

<jumplink id="object-error-2"></jumplink>
### Error

Error details when status is FAILED.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| code | string | ✓ | Error code (e.g. SIMULATION_FAILED). |
| message | string | ✓ | Human-readable error message. |
| failed_case_ids | array of string |  | IDs of cases that failed. |

## Authentication

| Scheme | Type | Location |
|--------|------|----------|
| OAuthToken__Authorization | HTTP Bearer | Header: `Authorization` |

### Usage Examples

- **OAuthToken__Authorization**: Include `Authorization: Bearer your-token-here` in request headers

### Global Authentication Requirements

All endpoints require: OAuthToken__Authorization