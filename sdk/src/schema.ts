// GÉNÉRÉ par `npm run sdk:contrat` depuis `sdk/openapi.json` (openapi-typescript) : ne pas modifier à la main.
// `tests/sdk-contrat.test.ts` le régénère et exige l'égalité.
export interface paths {
    "/v1/conversations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Lists conversations, most recent first, page by page.
         * @description Requires the conversations:read scope.
         */
        get: operations["listConversations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/conversations/{conversationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Reads a conversation: the contact, who handles it, the 24-hour window.
         * @description Requires the conversations:read scope.
         */
        get: operations["getConversation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/conversations/{conversationId}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * A conversation’s messages, most recent first, page by page.
         * @description Requires the conversations:read scope.
         */
        get: operations["listConversationMessages"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/messages/{messageId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Reads a message by its ID.
         * @description Requires the conversations:read scope.
         */
        get: operations["getMessage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/messages/{messageId}/media": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Downloads the file of a received message.
         * @description Requires the conversations:read scope.
         */
        get: operations["getMessageMedia"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/contacts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Creates or updates a record.
         * @description Requires the contacts:write scope.
         */
        post: operations["upsertContact"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/contacts/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Creates or updates up to 50 records in one call.
         * @description Requires the contacts:write scope.
         */
        post: operations["upsertContacts"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/contacts/{contactId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Reads a record.
         * @description Requires the contacts:read scope.
         */
        get: operations["getContact"];
        put?: never;
        post?: never;
        /**
         * Erases a record for good (GDPR), within the plan’s daily limit.
         * @description Requires the contacts:admin scope.
         */
        delete: operations["deleteContact"];
        options?: never;
        head?: never;
        /**
         * Updates a record’s fields, tags, consent or external id.
         * @description Requires the contacts:write scope.
         */
        patch: operations["updateContact"];
        trace?: never;
    };
    "/v1/contacts/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Finds a record by phone, BSUID or external id.
         * @description Requires the contacts:read scope.
         */
        post: operations["searchContact"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/fields": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Lists the custom fields: the keys to use in fields.
         * @description Requires the contacts:read scope.
         */
        get: operations["listFields"];
        put?: never;
        /**
         * Creates a custom field; its key comes from the label.
         * @description Requires the contacts:admin scope.
         */
        post: operations["createField"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Sends a message in Meta’s format: image, document, location, buttons, list, link button.
         * @description Requires the sends:create scope.
         */
        post: operations["sendMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/messages/whatsapp": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Sends a WhatsApp text right away to an existing record.
         * @description Requires the sends:create scope.
         */
        post: operations["sendWhatsappText"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/messages/rcs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Sends an RCS text right away to an existing record.
         * @description Requires the sends:create scope.
         */
        post: operations["sendRcsText"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sends": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Starts an asynchronous, idempotent send to 1 to 50 recipients.
         * @description Requires the sends:create scope.
         */
        post: operations["createSend"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sends/{sendId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Reads the state and results of a send.
         * @description Requires the sends:create scope.
         */
        get: operations["getSend"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Lists the approved, sendable WhatsApp templates.
         * @description Requires the sends:create scope.
         */
        get: operations["listTemplates"];
        put?: never;
        /**
         * Creates a template in Meta’s format and submits it for review.
         * @description Requires the templates:write scope.
         */
        post: operations["createTemplate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/templates/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Reads a template’s status at Meta, language by language.
         * @description Requires the templates:write scope.
         */
        get: operations["getTemplateStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhooks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Lists the endpoints, the plan limit and the available types.
         * @description Requires the webhooks:write scope.
         */
        get: operations["listWebhooks"];
        put?: never;
        /**
         * Registers an endpoint and returns its secret, only once.
         * @description Requires the webhooks:write scope.
         */
        post: operations["createWebhook"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhooks/{webhookId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Reads an endpoint and the state of its deliveries.
         * @description Requires the webhooks:write scope.
         */
        get: operations["getWebhook"];
        put?: never;
        post?: never;
        /**
         * Deletes an endpoint.
         * @description Requires the webhooks:write scope.
         */
        delete: operations["deleteWebhook"];
        options?: never;
        head?: never;
        /**
         * Changes the types, the description, or pauses the endpoint.
         * @description Requires the webhooks:write scope.
         */
        patch: operations["updateWebhook"];
        trace?: never;
    };
    "/v1/webhooks/{webhookId}/rotate-secret": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rotates the secret; the old one still signs for 24 h.
         * @description Requires the webhooks:write scope.
         */
        post: operations["rotateWebhookSecret"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhooks/{webhookId}/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Sends a signed test event and returns the app’s answer.
         * @description Requires the webhooks:write scope.
         */
        post: operations["testWebhook"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhooks/{webhookId}/deliveries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Reads an endpoint’s log, most recent first.
         * @description Requires the webhooks:write scope.
         */
        get: operations["listWebhookDeliveries"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhooks/deliveries/{deliveryId}/replay": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Replays a finished delivery, with the same body.
         * @description Requires the webhooks:write scope.
         */
        post: operations["replayWebhookDelivery"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhooks/{webhookId}/replay-failures": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Replays the failed deliveries since a date.
         * @description Requires the webhooks:write scope.
         */
        post: operations["replayWebhookFailures"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/scenarios": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Lists the published scenarios and their opening message.
         * @description Requires the sends:create scope.
         */
        get: operations["listScenarios"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/rcs-messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Lists the RCS messages of the library.
         * @description Requires the sends:create scope.
         */
        get: operations["listRcsMessages"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export interface webhooks {
    "message.received": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * A contact sent a message (WhatsApp or RCS).
         * @description Sent to every webhook endpoint subscribed to this type. Signed per Standard Webhooks.
         */
        post: {
            parameters: {
                query?: never;
                header: {
                    /** @description The event id (evt_…), stable across retries. */
                    "webhook-id": string;
                    /** @description Unix time in seconds; reject a timestamp more than 5 minutes away. */
                    "webhook-timestamp": string;
                    /** @description v1,<base64 HMAC-SHA256 of id.timestamp.body>, keyed with the base64-decoded part of the secret after whsec_; during a rotation, two signatures separated by a space. */
                    "webhook-signature": string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @description evt_ followed by 32 hex characters; stable across retries and replays. Also sent in webhook-id. */
                        id: string;
                        /** @constant */
                        type: "message.received";
                        /** @description ISO 8601 date-time */
                        created_at: string;
                        /** @description The workspace (tenant) ID. */
                        workspace_id: string;
                        data: {
                            contact: {
                                id: string;
                                phone: string | null;
                                name: string | null;
                                external_id: string | null;
                                opted_out: {
                                    whatsapp: boolean;
                                    rcs: boolean;
                                };
                            };
                            /** @enum {string} */
                            channel: "whatsapp" | "rcs";
                            message_id: string | null;
                            message_type: string | null;
                            text: string | null;
                            transcription: string | null;
                            button: string | null;
                        };
                    };
                };
            };
            responses: {
                /** @description Acknowledged. Anything else is retried for 24 hours. */
                "2XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "message.delivered": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * A message we sent was delivered.
         * @description Sent to every webhook endpoint subscribed to this type. Signed per Standard Webhooks.
         */
        post: {
            parameters: {
                query?: never;
                header: {
                    /** @description The event id (evt_…), stable across retries. */
                    "webhook-id": string;
                    /** @description Unix time in seconds; reject a timestamp more than 5 minutes away. */
                    "webhook-timestamp": string;
                    /** @description v1,<base64 HMAC-SHA256 of id.timestamp.body>, keyed with the base64-decoded part of the secret after whsec_; during a rotation, two signatures separated by a space. */
                    "webhook-signature": string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @description evt_ followed by 32 hex characters; stable across retries and replays. Also sent in webhook-id. */
                        id: string;
                        /** @constant */
                        type: "message.delivered";
                        /** @description ISO 8601 date-time */
                        created_at: string;
                        /** @description The workspace (tenant) ID. */
                        workspace_id: string;
                        data: {
                            contact: {
                                id: string;
                                phone: string | null;
                                name: string | null;
                                external_id: string | null;
                                opted_out: {
                                    whatsapp: boolean;
                                    rcs: boolean;
                                };
                            };
                            /** @enum {string} */
                            channel: "whatsapp" | "rcs";
                            message_id: string | null;
                            origin: string | null;
                            send_id: string | null;
                        };
                    };
                };
            };
            responses: {
                /** @description Acknowledged. Anything else is retried for 24 hours. */
                "2XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "message.read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * A message we sent was read.
         * @description Sent to every webhook endpoint subscribed to this type. Signed per Standard Webhooks.
         */
        post: {
            parameters: {
                query?: never;
                header: {
                    /** @description The event id (evt_…), stable across retries. */
                    "webhook-id": string;
                    /** @description Unix time in seconds; reject a timestamp more than 5 minutes away. */
                    "webhook-timestamp": string;
                    /** @description v1,<base64 HMAC-SHA256 of id.timestamp.body>, keyed with the base64-decoded part of the secret after whsec_; during a rotation, two signatures separated by a space. */
                    "webhook-signature": string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @description evt_ followed by 32 hex characters; stable across retries and replays. Also sent in webhook-id. */
                        id: string;
                        /** @constant */
                        type: "message.read";
                        /** @description ISO 8601 date-time */
                        created_at: string;
                        /** @description The workspace (tenant) ID. */
                        workspace_id: string;
                        data: {
                            contact: {
                                id: string;
                                phone: string | null;
                                name: string | null;
                                external_id: string | null;
                                opted_out: {
                                    whatsapp: boolean;
                                    rcs: boolean;
                                };
                            };
                            /** @enum {string} */
                            channel: "whatsapp" | "rcs";
                            message_id: string | null;
                            origin: string | null;
                            send_id: string | null;
                        };
                    };
                };
            };
            responses: {
                /** @description Acknowledged. Anything else is retried for 24 hours. */
                "2XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "message.failed": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * A message we sent failed.
         * @description Sent to every webhook endpoint subscribed to this type. Signed per Standard Webhooks.
         */
        post: {
            parameters: {
                query?: never;
                header: {
                    /** @description The event id (evt_…), stable across retries. */
                    "webhook-id": string;
                    /** @description Unix time in seconds; reject a timestamp more than 5 minutes away. */
                    "webhook-timestamp": string;
                    /** @description v1,<base64 HMAC-SHA256 of id.timestamp.body>, keyed with the base64-decoded part of the secret after whsec_; during a rotation, two signatures separated by a space. */
                    "webhook-signature": string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @description evt_ followed by 32 hex characters; stable across retries and replays. Also sent in webhook-id. */
                        id: string;
                        /** @constant */
                        type: "message.failed";
                        /** @description ISO 8601 date-time */
                        created_at: string;
                        /** @description The workspace (tenant) ID. */
                        workspace_id: string;
                        data: {
                            contact: {
                                id: string;
                                phone: string | null;
                                name: string | null;
                                external_id: string | null;
                                opted_out: {
                                    whatsapp: boolean;
                                    rcs: boolean;
                                };
                            };
                            /** @enum {string} */
                            channel: "whatsapp" | "rcs";
                            message_id: string | null;
                            origin: string | null;
                            send_id: string | null;
                            reason: string | null;
                            meta_code: number | null;
                        };
                    };
                };
            };
            responses: {
                /** @description Acknowledged. Anything else is retried for 24 hours. */
                "2XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "link.clicked": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * A contact clicked a tracked link.
         * @description Sent to every webhook endpoint subscribed to this type. Signed per Standard Webhooks.
         */
        post: {
            parameters: {
                query?: never;
                header: {
                    /** @description The event id (evt_…), stable across retries. */
                    "webhook-id": string;
                    /** @description Unix time in seconds; reject a timestamp more than 5 minutes away. */
                    "webhook-timestamp": string;
                    /** @description v1,<base64 HMAC-SHA256 of id.timestamp.body>, keyed with the base64-decoded part of the secret after whsec_; during a rotation, two signatures separated by a space. */
                    "webhook-signature": string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @description evt_ followed by 32 hex characters; stable across retries and replays. Also sent in webhook-id. */
                        id: string;
                        /** @constant */
                        type: "link.clicked";
                        /** @description ISO 8601 date-time */
                        created_at: string;
                        /** @description The workspace (tenant) ID. */
                        workspace_id: string;
                        data: {
                            contact: {
                                id: string;
                                phone: string | null;
                                name: string | null;
                                external_id: string | null;
                                opted_out: {
                                    whatsapp: boolean;
                                    rcs: boolean;
                                };
                            };
                            link: string;
                            template: string | null;
                            destination: string | null;
                        };
                    };
                };
            };
            responses: {
                /** @description Acknowledged. Anything else is retried for 24 hours. */
                "2XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "contact.opted_out": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * A contact opted out (STOP).
         * @description Sent to every webhook endpoint subscribed to this type. Signed per Standard Webhooks.
         */
        post: {
            parameters: {
                query?: never;
                header: {
                    /** @description The event id (evt_…), stable across retries. */
                    "webhook-id": string;
                    /** @description Unix time in seconds; reject a timestamp more than 5 minutes away. */
                    "webhook-timestamp": string;
                    /** @description v1,<base64 HMAC-SHA256 of id.timestamp.body>, keyed with the base64-decoded part of the secret after whsec_; during a rotation, two signatures separated by a space. */
                    "webhook-signature": string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @description evt_ followed by 32 hex characters; stable across retries and replays. Also sent in webhook-id. */
                        id: string;
                        /** @constant */
                        type: "contact.opted_out";
                        /** @description ISO 8601 date-time */
                        created_at: string;
                        /** @description The workspace (tenant) ID. */
                        workspace_id: string;
                        data: {
                            contact: {
                                id: string;
                                phone: string | null;
                                name: string | null;
                                external_id: string | null;
                                opted_out: {
                                    whatsapp: boolean;
                                    rcs: boolean;
                                };
                            };
                            channel: ("whatsapp" | "rcs") | null;
                            source: string | null;
                        };
                    };
                };
            };
            responses: {
                /** @description Acknowledged. Anything else is retried for 24 hours. */
                "2XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "conversation.analyzed": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * A conversation was analyzed (intent, sentiment, satisfaction, urgency).
         * @description Sent to every webhook endpoint subscribed to this type. Signed per Standard Webhooks.
         */
        post: {
            parameters: {
                query?: never;
                header: {
                    /** @description The event id (evt_…), stable across retries. */
                    "webhook-id": string;
                    /** @description Unix time in seconds; reject a timestamp more than 5 minutes away. */
                    "webhook-timestamp": string;
                    /** @description v1,<base64 HMAC-SHA256 of id.timestamp.body>, keyed with the base64-decoded part of the secret after whsec_; during a rotation, two signatures separated by a space. */
                    "webhook-signature": string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @description evt_ followed by 32 hex characters; stable across retries and replays. Also sent in webhook-id. */
                        id: string;
                        /** @constant */
                        type: "conversation.analyzed";
                        /** @description ISO 8601 date-time */
                        created_at: string;
                        /** @description The workspace (tenant) ID. */
                        workspace_id: string;
                        data: {
                            contact: {
                                id: string;
                                phone: string | null;
                                name: string | null;
                                external_id: string | null;
                                opted_out: {
                                    whatsapp: boolean;
                                    rcs: boolean;
                                };
                            };
                            conversation_id: string | null;
                            intent: string;
                            sentiment: string;
                            satisfaction: number | null;
                            urgency: number | null;
                            resolved: boolean;
                            topic: string;
                            action_suggestion: string;
                            handled_by: string;
                            exchanges_count: number;
                            summary: string | null;
                        };
                    };
                };
            };
            responses: {
                /** @description Acknowledged. Anything else is retried for 24 hours. */
                "2XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "contact.risk_changed": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * A contact’s disengagement risk level changed.
         * @description Sent to every webhook endpoint subscribed to this type. Signed per Standard Webhooks.
         */
        post: {
            parameters: {
                query?: never;
                header: {
                    /** @description The event id (evt_…), stable across retries. */
                    "webhook-id": string;
                    /** @description Unix time in seconds; reject a timestamp more than 5 minutes away. */
                    "webhook-timestamp": string;
                    /** @description v1,<base64 HMAC-SHA256 of id.timestamp.body>, keyed with the base64-decoded part of the secret after whsec_; during a rotation, two signatures separated by a space. */
                    "webhook-signature": string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @description evt_ followed by 32 hex characters; stable across retries and replays. Also sent in webhook-id. */
                        id: string;
                        /** @constant */
                        type: "contact.risk_changed";
                        /** @description ISO 8601 date-time */
                        created_at: string;
                        /** @description The workspace (tenant) ID. */
                        workspace_id: string;
                        data: {
                            contact: {
                                id: string;
                                phone: string | null;
                                name: string | null;
                                external_id: string | null;
                                opted_out: {
                                    whatsapp: boolean;
                                    rcs: boolean;
                                };
                            };
                            /** @enum {string} */
                            level: "inconnu" | "faible" | "moyen" | "eleve";
                            previous_level: ("inconnu" | "faible" | "moyen" | "eleve") | null;
                            score: number | null;
                            reasons: ("stop" | "bloque" | "silence_60j" | "silence_30j" | "sans_reponse" | "non_lu" | "reclamation" | "negatif" | "insatisfait" | "injoignable")[];
                        };
                    };
                };
            };
            responses: {
                /** @description Acknowledged. Anything else is retried for 24 hours. */
                "2XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "template.status_changed": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Meta approved, rejected, paused or disabled one of your templates.
         * @description Sent to every webhook endpoint subscribed to this type. Signed per Standard Webhooks.
         */
        post: {
            parameters: {
                query?: never;
                header: {
                    /** @description The event id (evt_…), stable across retries. */
                    "webhook-id": string;
                    /** @description Unix time in seconds; reject a timestamp more than 5 minutes away. */
                    "webhook-timestamp": string;
                    /** @description v1,<base64 HMAC-SHA256 of id.timestamp.body>, keyed with the base64-decoded part of the secret after whsec_; during a rotation, two signatures separated by a space. */
                    "webhook-signature": string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @description evt_ followed by 32 hex characters; stable across retries and replays. Also sent in webhook-id. */
                        id: string;
                        /** @constant */
                        type: "template.status_changed";
                        /** @description ISO 8601 date-time */
                        created_at: string;
                        /** @description The workspace (tenant) ID. */
                        workspace_id: string;
                        data: {
                            template: {
                                id: string;
                                name: string;
                                language: string;
                            };
                            /** @description Meta’s event, lowercase: approved, rejected, paused, disabled… */
                            status: string;
                            reason: string | null;
                        };
                    };
                };
            };
            responses: {
                /** @description Acknowledged. Anything else is retried for 24 hours. */
                "2XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "conversation.needs_reply": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Your application should reply.
         * @description Sent only to the endpoint designated as the responder (the workspace answers through your application), whether or not it subscribed to this type. Signed per Standard Webhooks.
         */
        post: {
            parameters: {
                query?: never;
                header: {
                    /** @description The event id (evt_…), stable across retries. */
                    "webhook-id": string;
                    /** @description Unix time in seconds; reject a timestamp more than 5 minutes away. */
                    "webhook-timestamp": string;
                    /** @description v1,<base64 HMAC-SHA256 of id.timestamp.body>, keyed with the base64-decoded part of the secret after whsec_; during a rotation, two signatures separated by a space. */
                    "webhook-signature": string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @description evt_ followed by 32 hex characters; stable across retries and replays. Also sent in webhook-id. */
                        id: string;
                        /** @constant */
                        type: "conversation.needs_reply";
                        /** @description ISO 8601 date-time */
                        created_at: string;
                        /** @description The workspace (tenant) ID. */
                        workspace_id: string;
                        data: {
                            contact: {
                                id: string;
                                phone: string | null;
                                name: string | null;
                                external_id: string | null;
                                opted_out: {
                                    whatsapp: boolean;
                                    rcs: boolean;
                                };
                            } | null;
                            conversation_id: string | null;
                            /** @constant */
                            channel: "whatsapp";
                            message_id: string | null;
                            message_type: string | null;
                            text: string | null;
                            transcription: string | null;
                            reply_with: {
                                /** @constant */
                                method: "POST";
                                /** @constant */
                                path: "/v1/messages/whatsapp";
                            };
                        };
                    };
                };
            };
            responses: {
                /** @description Acknowledged. Anything else is retried for 24 hours. */
                "2XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    test: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * A test event.
         * @description Sent only by POST /v1/webhooks/{webhookId}/test, to that endpoint. Signed per Standard Webhooks.
         */
        post: {
            parameters: {
                query?: never;
                header: {
                    /** @description The event id (evt_…), stable across retries. */
                    "webhook-id": string;
                    /** @description Unix time in seconds; reject a timestamp more than 5 minutes away. */
                    "webhook-timestamp": string;
                    /** @description v1,<base64 HMAC-SHA256 of id.timestamp.body>, keyed with the base64-decoded part of the secret after whsec_; during a rotation, two signatures separated by a space. */
                    "webhook-signature": string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @description evt_ followed by 32 hex characters; stable across retries and replays. Also sent in webhook-id. */
                        id: string;
                        /** @constant */
                        type: "test";
                        /** @description ISO 8601 date-time */
                        created_at: string;
                        /** @description The workspace (tenant) ID. */
                        workspace_id: string;
                        data: {
                            message: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Acknowledged. Anything else is retried for 24 hours. */
                "2XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export interface components {
    schemas: {
        Error: {
            /** @description A human-readable message (French). */
            error: string;
            /**
             * @description The stable machine-readable code. Absent only on generic failures: malformed JSON, payload too large, an upstream error from Meta, an internal error.
             * @enum {string}
             */
            code?: "invalid_body" | "invalid_recipient" | "invalid_phone" | "unauthorized" | "missing_scope" | "tenant_locked" | "unknown_contact" | "duplicate" | "identity_conflict" | "blocked_contact" | "opted_out" | "no_consent" | "window_closed" | "missing_variable" | "no_phone" | "rcs_unreachable" | "rcs_not_enabled" | "no_whatsapp_number" | "meta_rejected" | "invalid_header_media" | "template_rejected" | "meta_auth_failed" | "webhook_not_found" | "delivery_not_found" | "delivery_not_replayable" | "webhooks_unavailable" | "field_exists" | "number_unlinked" | "number_suspended" | "scenario_not_found" | "node_not_found" | "template_not_found" | "rcs_message_not_found" | "send_not_found" | "conversation_not_found" | "message_not_found" | "invalid_cursor" | "no_media" | "media_expired" | "media_unavailable" | "scenario_ambiguous" | "unsendable_target" | "template_category_unknown" | "idempotency_key_required" | "idempotency_in_progress" | "idempotency_key_reused" | "rate_limited" | "quota_exceeded" | "plan_feature_unavailable" | "plan_limit_reached";
            /** @description On 402 (plan_feature_unavailable, plan_limit_reached): the page where the plan is upgraded. */
            upgradeUrl?: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listConversations: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
                needsReply?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            id: string;
                            contact: {
                                id: string | null;
                                phone: string | null;
                                name: string | null;
                                externalId: string | null;
                            };
                            /** @description ISO 8601 date-time */
                            lastMessageAt: string;
                            lastDirection: ("in" | "out") | null;
                            windowExpiresAt: string | null;
                            /** @enum {string} */
                            handledBy: "team" | "meta_agent" | "automation";
                            needsReply: boolean;
                            archived: boolean;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Error: invalid_body, invalid_cursor. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getConversation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversationId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        contact: {
                            id: string | null;
                            phone: string | null;
                            name: string | null;
                            externalId: string | null;
                        };
                        /** @description ISO 8601 date-time */
                        lastMessageAt: string;
                        lastDirection: ("in" | "out") | null;
                        windowExpiresAt: string | null;
                        /** @enum {string} */
                        handledBy: "team" | "meta_agent" | "automation";
                        needsReply: boolean;
                        archived: boolean;
                    };
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: conversation_not_found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listConversationMessages: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
            };
            header?: never;
            path: {
                conversationId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            id: string;
                            conversationId: string;
                            /** @enum {string} */
                            direction: "in" | "out";
                            /** @enum {string} */
                            channel: "whatsapp" | "rcs";
                            type: string | null;
                            text: string | null;
                            buttonPayload: string | null;
                            transcription: string | null;
                            media: {
                                mimeType: string | null;
                                filename: string | null;
                                expired: boolean;
                            } | null;
                            status: ("sent" | "delivered" | "read" | "failed") | null;
                            statusAt: string | null;
                            error: {
                                code: number | null;
                                reason: string | null;
                            } | null;
                            /** @description ISO 8601 date-time */
                            createdAt: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Error: invalid_body, invalid_cursor. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: conversation_not_found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                messageId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        conversationId: string;
                        /** @enum {string} */
                        direction: "in" | "out";
                        /** @enum {string} */
                        channel: "whatsapp" | "rcs";
                        type: string | null;
                        text: string | null;
                        buttonPayload: string | null;
                        transcription: string | null;
                        media: {
                            mimeType: string | null;
                            filename: string | null;
                            expired: boolean;
                        } | null;
                        status: ("sent" | "delivered" | "read" | "failed") | null;
                        statusAt: string | null;
                        error: {
                            code: number | null;
                            reason: string | null;
                        } | null;
                        /** @description ISO 8601 date-time */
                        createdAt: string;
                    };
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: message_not_found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getMessageMedia: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                messageId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The file, served with its own content type (image, audio, video, document). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": unknown;
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: message_not_found, no_media. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: media_expired. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: media_unavailable. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    upsertContact: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    contactId?: string;
                    externalId?: string;
                    phone?: string;
                    bsuid?: string;
                    name?: string;
                    fields?: {
                        [key: string]: string | number | boolean;
                    };
                    tags?: (string | number)[];
                    /** @enum {string} */
                    consent?: "opted_in" | "opted_out";
                    consentSource?: string;
                    optIn?: unknown;
                    optInSource?: unknown;
                };
            };
        };
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        contactId: string;
                        /** @enum {string} */
                        status: "created" | "updated";
                    };
                };
            };
            /** @description Error: invalid_body, invalid_recipient, invalid_phone. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: plan_limit_reached. */
            402: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unknown_contact. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: identity_conflict, opted_out. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    upsertContacts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    contacts: {
                        /** Format: uuid */
                        contactId?: string;
                        externalId?: string;
                        phone?: string;
                        bsuid?: string;
                        name?: string;
                        fields?: {
                            [key: string]: string | number | boolean;
                        };
                        tags?: (string | number)[];
                        /** @enum {string} */
                        consent?: "opted_in" | "opted_out";
                        consentSource?: string;
                        optIn?: unknown;
                        optInSource?: unknown;
                    }[];
                };
            };
        };
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        results: ({
                            index: number;
                            /** @enum {string} */
                            status: "created" | "updated";
                            contactId: string;
                        } | {
                            index: number;
                            /** @constant */
                            status: "error";
                            /** @enum {string} */
                            code: "invalid_body" | "invalid_recipient" | "invalid_phone" | "unauthorized" | "missing_scope" | "tenant_locked" | "unknown_contact" | "duplicate" | "identity_conflict" | "blocked_contact" | "opted_out" | "no_consent" | "window_closed" | "missing_variable" | "no_phone" | "rcs_unreachable" | "rcs_not_enabled" | "no_whatsapp_number" | "meta_rejected" | "invalid_header_media" | "template_rejected" | "meta_auth_failed" | "webhook_not_found" | "delivery_not_found" | "delivery_not_replayable" | "webhooks_unavailable" | "field_exists" | "number_unlinked" | "number_suspended" | "scenario_not_found" | "node_not_found" | "template_not_found" | "rcs_message_not_found" | "send_not_found" | "conversation_not_found" | "message_not_found" | "invalid_cursor" | "no_media" | "media_expired" | "media_unavailable" | "scenario_ambiguous" | "unsendable_target" | "template_category_unknown" | "idempotency_key_required" | "idempotency_in_progress" | "idempotency_key_reused" | "rate_limited" | "quota_exceeded" | "plan_feature_unavailable" | "plan_limit_reached";
                            reason: string;
                        })[];
                        created: number;
                        updated: number;
                        errors: number;
                    };
                };
            };
            /** @description Error: invalid_body. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getContact: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                contactId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        contactId: string;
                        externalId: string | null;
                        phone: string | null;
                        bsuid: string | null;
                        name: string | null;
                        fields: {
                            [key: string]: unknown;
                        };
                        tags: string[];
                        consent: {
                            /** @enum {string} */
                            status: "opted_in" | "opted_out" | "unknown";
                            source: string | null;
                            optedOutAt: string | null;
                        };
                        rcsOptedOutAt: string | null;
                        blocked: boolean;
                        reachability: {
                            whatsapp: boolean | null;
                            rcs: boolean | null;
                        };
                        engagementRisk: {
                            /** @enum {string} */
                            level: "inconnu" | "faible" | "moyen" | "eleve";
                            score: number | null;
                            reasons: ("stop" | "bloque" | "silence_60j" | "silence_30j" | "sans_reponse" | "non_lu" | "reclamation" | "negatif" | "insatisfait" | "injoignable")[];
                            /** @description ISO 8601 date-time */
                            computedAt: string;
                        } | null;
                        lastAnalysis: {
                            /** @enum {string} */
                            intent: "demande_devis" | "sav" | "reclamation" | "information" | "prise_rdv" | "achat" | "suivi_commande" | "retour" | "autre";
                            /** @enum {string} */
                            sentiment: "positif" | "neutre" | "negatif";
                            satisfaction: number | null;
                            urgency: number | null;
                            resolved: boolean;
                            topic: string;
                            /** @enum {string} */
                            handledBy: "humain" | "automatise" | "mba";
                            /** @enum {string} */
                            actionSuggestion: "creer_devis" | "rappeler" | "relancer" | "escalader" | "aucune";
                            /** @description ISO 8601 date-time */
                            analyzedAt: string;
                        } | null;
                        /** @description ISO 8601 date-time */
                        createdAt: string;
                    };
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unknown_contact. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteContact: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                contactId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        deleted: true;
                        conversations: number;
                        messages: number;
                    };
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: plan_limit_reached. */
            402: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unknown_contact. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    updateContact: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                contactId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name?: string | null;
                    fields?: {
                        [key: string]: (string | number | boolean) | null;
                    };
                    addTags?: (string | number)[];
                    removeTags?: (string | number)[];
                    /** @enum {string} */
                    consent?: "opted_in" | "opted_out";
                    consentSource?: string;
                    externalId?: string;
                    phone?: unknown;
                    bsuid?: unknown;
                };
            };
        };
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        contactId: string;
                    };
                };
            };
            /** @description Error: invalid_body, invalid_phone. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unknown_contact. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: identity_conflict, opted_out. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    searchContact: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    externalId?: string;
                    phone?: string;
                    bsuid?: string;
                };
            };
        };
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        contact: {
                            contactId: string;
                            externalId: string | null;
                            phone: string | null;
                            bsuid: string | null;
                            name: string | null;
                            fields: {
                                [key: string]: unknown;
                            };
                            tags: string[];
                            consent: {
                                /** @enum {string} */
                                status: "opted_in" | "opted_out" | "unknown";
                                source: string | null;
                                optedOutAt: string | null;
                            };
                            rcsOptedOutAt: string | null;
                            blocked: boolean;
                            reachability: {
                                whatsapp: boolean | null;
                                rcs: boolean | null;
                            };
                            engagementRisk: {
                                /** @enum {string} */
                                level: "inconnu" | "faible" | "moyen" | "eleve";
                                score: number | null;
                                reasons: ("stop" | "bloque" | "silence_60j" | "silence_30j" | "sans_reponse" | "non_lu" | "reclamation" | "negatif" | "insatisfait" | "injoignable")[];
                                /** @description ISO 8601 date-time */
                                computedAt: string;
                            } | null;
                            lastAnalysis: {
                                /** @enum {string} */
                                intent: "demande_devis" | "sav" | "reclamation" | "information" | "prise_rdv" | "achat" | "suivi_commande" | "retour" | "autre";
                                /** @enum {string} */
                                sentiment: "positif" | "neutre" | "negatif";
                                satisfaction: number | null;
                                urgency: number | null;
                                resolved: boolean;
                                topic: string;
                                /** @enum {string} */
                                handledBy: "humain" | "automatise" | "mba";
                                /** @enum {string} */
                                actionSuggestion: "creer_devis" | "rappeler" | "relancer" | "escalader" | "aucune";
                                /** @description ISO 8601 date-time */
                                analyzedAt: string;
                            } | null;
                            /** @description ISO 8601 date-time */
                            createdAt: string;
                        } | null;
                    };
                };
            };
            /** @description Error: invalid_body, invalid_phone. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listFields: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            key: string;
                            label: string;
                            type: string;
                        }[];
                    };
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    createField: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    label: string;
                    /** @enum {string} */
                    type: "text" | "number" | "date" | "datetime" | "boolean" | "url";
                };
            };
        };
        responses: {
            /** @description Success. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        key: string;
                        label: string;
                        type: string;
                    };
                };
            };
            /** @description Error: invalid_body. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: field_exists. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    sendMessage: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @constant */
                    messaging_product?: "whatsapp";
                    /** @constant */
                    recipient_type?: "individual";
                    to?: string;
                    /** Format: uuid */
                    contactId?: string;
                    externalId?: string;
                    /** @enum {string} */
                    type: "text" | "image" | "video" | "audio" | "document" | "location" | "reaction" | "interactive";
                    text?: {
                        body: string;
                        preview_url?: boolean;
                    };
                    image?: {
                        /** Format: uri */
                        link: string;
                        caption?: string;
                    };
                    video?: {
                        /** Format: uri */
                        link: string;
                        caption?: string;
                    };
                    audio?: {
                        /** Format: uri */
                        link: string;
                        voice?: boolean;
                    };
                    document?: {
                        /** Format: uri */
                        link: string;
                        caption?: string;
                        filename?: string;
                    };
                    location?: {
                        latitude: number;
                        longitude: number;
                        name?: string;
                        address?: string;
                    };
                    reaction?: {
                        message_id: string;
                        emoji: string;
                    };
                    interactive?: {
                        /** @constant */
                        type: "button";
                        header?: {
                            /** @constant */
                            type: "text";
                            text: string;
                        } | {
                            /** @constant */
                            type: "image";
                            image: {
                                /** Format: uri */
                                link: string;
                            };
                        } | {
                            /** @constant */
                            type: "video";
                            video: {
                                /** Format: uri */
                                link: string;
                            };
                        } | {
                            /** @constant */
                            type: "document";
                            document: {
                                /** Format: uri */
                                link: string;
                                filename?: string;
                            };
                        };
                        body: {
                            text: string;
                        };
                        footer?: {
                            text: string;
                        };
                        action: {
                            buttons: {
                                /** @constant */
                                type: "reply";
                                reply: {
                                    id: string;
                                    title: string;
                                };
                            }[];
                        };
                    } | {
                        /** @constant */
                        type: "list";
                        header?: {
                            /** @constant */
                            type: "text";
                            text: string;
                        };
                        body: {
                            text: string;
                        };
                        footer?: {
                            text: string;
                        };
                        action: {
                            button: string;
                            sections: {
                                title?: string;
                                rows: {
                                    id: string;
                                    title: string;
                                    description?: string;
                                }[];
                            }[];
                        };
                    } | {
                        /** @constant */
                        type: "cta_url";
                        header?: {
                            /** @constant */
                            type: "text";
                            text: string;
                        } | {
                            /** @constant */
                            type: "image";
                            image: {
                                /** Format: uri */
                                link: string;
                            };
                        } | {
                            /** @constant */
                            type: "video";
                            video: {
                                /** Format: uri */
                                link: string;
                            };
                        } | {
                            /** @constant */
                            type: "document";
                            document: {
                                /** Format: uri */
                                link: string;
                                filename?: string;
                            };
                        };
                        body: {
                            text: string;
                        };
                        footer?: {
                            text: string;
                        };
                        action: {
                            /** @constant */
                            name: "cta_url";
                            parameters: {
                                display_text: string;
                                /** Format: uri */
                                url: string;
                            };
                        };
                    };
                };
            };
        };
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        messageId: string;
                        conversationId: string | null;
                        /** @enum {string} */
                        channel: "whatsapp" | "rcs";
                    };
                };
            };
            /** @description Error: invalid_body, invalid_recipient, invalid_phone. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unknown_contact. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: identity_conflict, blocked_contact, opted_out, no_whatsapp_number, number_unlinked, number_suspended. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: window_closed, meta_rejected. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    sendWhatsappText: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    contactId?: string;
                    externalId?: string;
                    phone?: string;
                    bsuid?: string;
                    text: string;
                };
            };
        };
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        messageId: string;
                        conversationId: string | null;
                        /** @enum {string} */
                        channel: "whatsapp" | "rcs";
                    };
                };
            };
            /** @description Error: invalid_body, invalid_recipient, invalid_phone. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unknown_contact. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: identity_conflict, blocked_contact, opted_out, no_whatsapp_number, number_unlinked, number_suspended. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: window_closed, meta_rejected. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    sendRcsText: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    contactId?: string;
                    externalId?: string;
                    phone?: string;
                    bsuid?: string;
                    text: string;
                };
            };
        };
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        messageId: string;
                        conversationId: string | null;
                        /** @enum {string} */
                        channel: "whatsapp" | "rcs";
                    };
                };
            };
            /** @description Error: invalid_body, invalid_recipient, invalid_phone. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unknown_contact. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: identity_conflict, blocked_contact, opted_out, no_consent, rcs_not_enabled. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: no_phone, rcs_unreachable. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    createSend: {
        parameters: {
            query?: never;
            header?: {
                /** @description Makes the call safe to replay: the same key returns the first result. Required unless the body has idempotencyKey. */
                "Idempotency-Key"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    idempotencyKey?: string;
                    target: {
                        template: {
                            name: string;
                            language: string;
                        };
                    } | {
                        scenario: string;
                    } | {
                        node: string;
                    } | {
                        rcsMessage: string;
                    };
                    recipients: {
                        /** Format: uuid */
                        contactId?: string;
                        externalId?: string;
                        phone?: string;
                        bsuid?: string;
                        /** @enum {string} */
                        consent?: "opted_in" | "opted_out";
                        consentSource?: string;
                        /** @description Values for this recipient only, never written on the record: the {{name}} of an RCS message, or a template parameter of source variable. */
                        variables?: {
                            [key: string]: string;
                        };
                    }[];
                    /** @description Template parameters: positions run from 1 to N, with no gap and no repeat. */
                    params?: {
                        position: number;
                        source: {
                            /** @constant */
                            type: "field";
                            key: string;
                        } | {
                            /** @constant */
                            type: "attribute";
                            /** @enum {string} */
                            key: "name" | "phone" | "bsuid" | "wa_id";
                        } | {
                            /** @constant */
                            type: "now";
                        } | {
                            /** @constant */
                            type: "literal";
                            value: string;
                        } | {
                            /** @constant */
                            type: "variable";
                            key: string;
                        };
                        fallback?: string;
                    }[];
                    /** @enum {string} */
                    category?: "marketing" | "utility";
                    ratePerMinute?: number;
                    phoneNumberId?: string;
                };
            };
        };
        responses: {
            /** @description Success. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        sendId: string;
                        /** @enum {string} */
                        opening: "whatsapp_template" | "whatsapp_session" | "rcs";
                        recipientCount: number;
                        created: number;
                        matched: number;
                        skipped: {
                            index: number;
                            /** @enum {string} */
                            reason: "invalid_recipient" | "invalid_phone" | "unknown_contact" | "duplicate" | "identity_conflict" | "blocked_contact" | "opted_out" | "no_consent" | "window_closed" | "missing_variable" | "no_phone" | "plan_limit_reached";
                        }[];
                        skippedTotal: number;
                    };
                };
            };
            /** @description Error: invalid_body, idempotency_key_required. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: plan_feature_unavailable, plan_limit_reached. */
            402: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: template_not_found, scenario_not_found, node_not_found, rcs_message_not_found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: idempotency_in_progress, no_whatsapp_number, number_unlinked, number_suspended, scenario_ambiguous, rcs_not_enabled. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: idempotency_key_reused, template_category_unknown, unsendable_target. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getSend: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sendId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        sendId: string;
                        /** @enum {string} */
                        status: "draft" | "running" | "paused" | "completed" | "failed" | "scheduled";
                        target: {
                            template: {
                                name: string;
                                language: string;
                            };
                        } | {
                            scenario: string | null;
                        } | {
                            node: string | null;
                        } | {
                            rcsMessage: string | null;
                        };
                        opening: ("whatsapp_template" | "whatsapp_session" | "rcs") | null;
                        /** @description ISO 8601 date-time */
                        createdAt: string;
                        counts: {
                            pending: number;
                            sending: number;
                            sent: number;
                            failed: number;
                            skipped: number;
                        };
                        recipientsTotal: number;
                        recipients: {
                            contactId: string;
                            externalId: string | null;
                            /** @enum {string} */
                            channel: "whatsapp" | "rcs" | "email";
                            status: string;
                            messageId: string | null;
                            delivery: string | null;
                            error: {
                                message: string;
                                metaCode: number | null;
                            } | null;
                            sentAt: string | null;
                        }[];
                    };
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: send_not_found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listTemplates: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        templates: {
                            name: string;
                            language: string;
                            /** @enum {string} */
                            category: "marketing" | "utility";
                            /** @enum {string} */
                            header: "none" | "text" | "image" | "video" | "document";
                            variables: {
                                position: number;
                                source: ({
                                    /** @constant */
                                    type: "field";
                                    key: string;
                                } | {
                                    /** @constant */
                                    type: "attribute";
                                    /** @enum {string} */
                                    key: "name" | "phone" | "bsuid" | "wa_id";
                                } | {
                                    /** @constant */
                                    type: "now";
                                } | {
                                    /** @constant */
                                    type: "literal";
                                    value: string;
                                } | {
                                    /** @constant */
                                    type: "variable";
                                    key: string;
                                }) | null;
                            }[];
                        }[];
                    };
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    createTemplate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                    language: string;
                    /** @enum {string} */
                    category: "UTILITY" | "MARKETING";
                    /** @constant */
                    parameter_format?: "POSITIONAL";
                    components: ({
                        /** @constant */
                        type: "HEADER";
                        /** @enum {string} */
                        format: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
                        text?: string;
                        example?: {
                            header_url?: string[];
                            header_handle?: unknown;
                        };
                    } | {
                        /** @constant */
                        type: "BODY";
                        text: string;
                        example?: {
                            body_text: string[][];
                        };
                    } | {
                        /** @constant */
                        type: "FOOTER";
                        text: string;
                    } | {
                        /** @constant */
                        type: "BUTTONS";
                        buttons: ({
                            /** @constant */
                            type: "QUICK_REPLY";
                            text: string;
                        } | {
                            /** @constant */
                            type: "URL";
                            text: string;
                            /** Format: uri */
                            url: string;
                        })[];
                    })[];
                };
            };
        };
        responses: {
            /** @description Success. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        name: string;
                        language: string;
                        category: string;
                        status: string;
                    };
                };
            };
            /** @description Error: invalid_body. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: meta_auth_failed, no_whatsapp_number. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: invalid_header_media, template_rejected, meta_rejected. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getTemplateStatus: {
        parameters: {
            query?: {
                language?: string;
            };
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        name: string;
                        languages: {
                            language: string;
                            status: string;
                            category: string | null;
                            rejectedReason: string | null;
                        }[];
                    };
                };
            };
            /** @description Error: invalid_body. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: template_not_found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: meta_auth_failed, no_whatsapp_number. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: meta_rejected. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listWebhooks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            id: string;
                            url: string;
                            description: string;
                            types: string[];
                            active: boolean;
                            /** @description ISO 8601 date-time */
                            createdAt: string;
                            previousSecretValidUntil: string | null;
                            lastDeliveredAt: string | null;
                            retrying: number;
                            failed: number;
                        }[];
                        /** @description The plan’s maximum number of endpoints; null: unlimited. */
                        limit: number | null;
                        types: ("message.received" | "message.delivered" | "message.read" | "message.failed" | "link.clicked" | "contact.opted_out" | "conversation.analyzed" | "contact.risk_changed" | "template.status_changed")[];
                        defaultTypes: ("message.received" | "message.delivered" | "message.read" | "message.failed" | "link.clicked" | "contact.opted_out" | "conversation.analyzed" | "contact.risk_changed" | "template.status_changed")[];
                    };
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    createWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    url: string;
                    description?: string;
                    types?: ("message.received" | "message.delivered" | "message.read" | "message.failed" | "link.clicked" | "contact.opted_out" | "conversation.analyzed" | "contact.risk_changed" | "template.status_changed")[];
                };
            };
        };
        responses: {
            /** @description Success. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        webhook: {
                            id: string;
                            url: string;
                            description: string;
                            types: string[];
                            active: boolean;
                            /** @description ISO 8601 date-time */
                            createdAt: string;
                            previousSecretValidUntil: string | null;
                            lastDeliveredAt: string | null;
                            retrying: number;
                            failed: number;
                        };
                        /** @description whsec_…, returned only here and at rotation. */
                        secret: string;
                    };
                };
            };
            /** @description Error: invalid_body. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: plan_limit_reached. */
            402: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: webhooks_unavailable. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        url: string;
                        description: string;
                        types: string[];
                        active: boolean;
                        /** @description ISO 8601 date-time */
                        createdAt: string;
                        previousSecretValidUntil: string | null;
                        lastDeliveredAt: string | null;
                        retrying: number;
                        failed: number;
                    };
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: webhook_not_found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success, no content. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: webhook_not_found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    updateWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string;
                    types?: ("message.received" | "message.delivered" | "message.read" | "message.failed" | "link.clicked" | "contact.opted_out" | "conversation.analyzed" | "contact.risk_changed" | "template.status_changed")[];
                    active?: boolean;
                };
            };
        };
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        url: string;
                        description: string;
                        types: string[];
                        active: boolean;
                        /** @description ISO 8601 date-time */
                        createdAt: string;
                        previousSecretValidUntil: string | null;
                        lastDeliveredAt: string | null;
                        retrying: number;
                        failed: number;
                    };
                };
            };
            /** @description Error: invalid_body. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: plan_limit_reached. */
            402: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: webhook_not_found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    rotateWebhookSecret: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        secret: string;
                        /** @description ISO 8601 date-time */
                        previousSecretValidUntil: string;
                    };
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: webhook_not_found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: webhooks_unavailable. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    testWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        eventId: string;
                        delivered: boolean;
                        statusCode: number | null;
                        response: string;
                    };
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: webhook_not_found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: webhooks_unavailable. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listWebhookDeliveries: {
        parameters: {
            query?: {
                before?: string;
                limit?: number;
            };
            header?: never;
            path: {
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            id: string;
                            eventId: string;
                            type: string;
                            /** @enum {string} */
                            status: "pending" | "delivered" | "failed";
                            attempts: number;
                            lastStatusCode: number | null;
                            lastResponse: string | null;
                            nextAttemptAt: string | null;
                            /** @description ISO 8601 date-time */
                            createdAt: string;
                            deliveredAt: string | null;
                            /** @description The exact body that was sent, byte for byte. */
                            body: string;
                        }[];
                        /** @description Pass it as before for the next page. */
                        nextBefore: string | null;
                    };
                };
            };
            /** @description Error: invalid_body. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: webhook_not_found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    replayWebhookDelivery: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                deliveryId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        replayed: true;
                    };
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: delivery_not_found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: delivery_not_replayable. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    replayWebhookFailures: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: date-time */
                    since: string;
                };
            };
        };
        responses: {
            /** @description Success. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description How many deliveries were replayed. */
                        replayed: number;
                    };
                };
            };
            /** @description Error: invalid_body. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: webhook_not_found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listScenarios: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        scenarios: {
                            code: string | null;
                            name: string;
                            opening: ("whatsapp_template" | "whatsapp_session" | "rcs") | null;
                            openingTemplate: {
                                name: string;
                                language: string;
                            } | null;
                            entryNode: string | null;
                            publishedAt: string | null;
                        }[];
                    };
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listRcsMessages: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        rcsMessages: {
                            name: string;
                            /** @enum {string} */
                            kind: "text" | "card" | "carousel";
                            variables: string[];
                        }[];
                    };
                };
            };
            /** @description Error: unauthorized. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: missing_scope, tenant_locked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Error: rate_limited, quota_exceeded. Wait for Retry-After (seconds) before retrying. */
            429: {
                headers: {
                    /** @description Seconds to wait. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
}
