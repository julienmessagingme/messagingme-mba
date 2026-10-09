import { z } from 'zod';
import { schemaContactLotV1, schemaContactV1, schemaPatchContactV1, schemaRechercheContactV1 } from '../contacts-v1';
import { LIMITE_PAGE_DEFAUT, LIMITE_PAGE_MAX } from '../conversations-v1';
import { schemaMessageMeta } from '../message-meta';
import { schemaModeleMeta } from '../modele-meta';
import { MAX_BATCH } from '../../http/v1-contacts';
import { corpsChamp } from '../../http/v1-contacts-admin';
import { schemaMessageWhatsapp } from '../../http/v1-messages';
import { schemaMessageRcs } from '../../http/v1-messages-rcs';
import { schemaCorps, schemaDestinataire, MAX_RECIPIENTS } from '../../http/v1-sends';
import { requeteStatutModele } from '../../http/v1-templates';
import { corpsRejeu, requeteJournal } from '../../http/v1-webhooks';
import { saisieCreation, saisieModification } from '../../evenements/gestion';
import type { CodeApi } from '../erreurs';
import type { RouteOpenapi } from './document';
import {
  champV1, champs, contactEcrit, contactModifie, contactTrouve, contactsLot, conversationV1, essaiWebhook, ficheApi,
  ficheEffacee, journalWebhook, listeWebhooks, messageV1, modeleCree, pageV1, paramSource, rapportEnvoi, rejeu, rejeuEchecs,
  reponseMessageSimple, reponseMessagesRcs, reponseScenarios, reponseTemplates, secretTourne, statutModele, suiviEnvoi,
  webhookCree, webhookV1,
} from './reponses';

/**
 * LE REGISTRE DES ROUTES `/v1` (lot 16) : ce que le contrat OpenAPI dit de chacune. Les schémas d'ENTRÉE sont ceux que
 * les routes appliquent, importés d'elles ; trois seulement sont composés ici pour la doc, parce que la route lit son
 * corps en deux temps (un conteneur, puis chaque élément) : le lot de fiches, l'envoi (ses destinataires et ses
 * `params`). `tests/openapi.test.ts` tient ce registre égal aux routes montées (dans les deux sens), à l'index de la doc
 * (`web/lib/api-doc-endpoints.ts` : droit, groupe, phrase), et fait passer chaque exemple de la doc dans ses schémas.
 */

const uuid = z.string().uuid();
const pagination = {
  limit: z.number().int().min(1).max(LIMITE_PAGE_MAX).default(LIMITE_PAGE_DEFAUT).describe('Page size.'),
  cursor: z.string().max(200).describe('The nextCursor of the previous page, as is.'),
};

/** Le lot de fiches : la route lit d'abord un tableau, puis chaque élément par `schemaContactLotV1`. */
export const corpsLotDeFiches = z.strictObject({ contacts: z.array(schemaContactLotV1).min(1).max(MAX_BATCH) });

/** Une variable de template : sa position (`{{1}}`), d'où vient sa valeur, et sa valeur de repli (`TemplateParam`). */
export const parametreTemplate = z.strictObject({
  position: z.number().int().min(1),
  source: paramSource,
  fallback: z.string().optional(),
});

/** L'envoi : la route lit les destinataires un à un (un mal formé est écarté, il ne fait pas tomber l'envoi). */
export const corpsEnvoi = schemaCorps.extend({
  // `variables` se lit en deux temps dans la route (`schemaVariables`, un `unknown` puis un dictionnaire), que le JSON
  // Schema rendrait vide : sa forme est dite ici, ses bornes restent celles de la route.
  recipients: z.array(schemaDestinataire.extend({
    variables: z.record(z.string(), z.string()).optional()
      .describe('Values for this recipient only, never written on the record: the {{name}} of an RCS message, or a template parameter of source variable.'),
  })).min(1).max(MAX_RECIPIENTS),
  params: z.array(parametreTemplate).optional().describe('Template parameters: positions run from 1 to N, with no gap and no repeat.'),
}).describe('One target, 1 to 50 recipients. A malformed recipient is skipped (see skipped in the response), it does not fail the send.');

const RESOLUTION: readonly CodeApi[] = ['invalid_recipient', 'invalid_phone', 'unknown_contact', 'identity_conflict'];
const NUMERO: readonly CodeApi[] = ['no_whatsapp_number', 'number_unlinked', 'number_suspended'];
const MESSAGE_WHATSAPP: readonly CodeApi[] = ['invalid_body', ...RESOLUTION, 'blocked_contact', 'window_closed', 'opted_out', ...NUMERO, 'meta_rejected'];

const C = 'Contacts';
const M = 'Messages';
const CV = 'Conversations';
const E = 'Sends';
const T = 'Templates';
const W = 'Outgoing webhooks';
const K = 'Catalogs';

export const ROUTES_V1: readonly RouteOpenapi[] = [
  {
    methode: 'GET', chemin: '/v1/conversations', droit: 'conversations:read', groupe: CV, operationId: 'listConversations',
    resume: 'Lists conversations, most recent first, page by page.',
    requete: z.object({ ...pagination, needsReply: z.boolean().describe('Only the conversations waiting for your reply.') }).partial(),
    succes: { statut: 200, schema: pageV1(conversationV1) }, erreurs: ['invalid_body', 'invalid_cursor'],
  },
  {
    methode: 'GET', chemin: '/v1/conversations/{conversationId}', droit: 'conversations:read', groupe: CV, operationId: 'getConversation',
    resume: 'Reads a conversation: the contact, who handles it, the 24-hour window.',
    parametres: z.object({ conversationId: uuid }), succes: { statut: 200, schema: conversationV1 }, erreurs: ['conversation_not_found'],
  },
  {
    methode: 'GET', chemin: '/v1/conversations/{conversationId}/messages', droit: 'conversations:read', groupe: CV,
    operationId: 'listConversationMessages', resume: 'A conversation’s messages, most recent first, page by page.',
    parametres: z.object({ conversationId: uuid }), requete: z.object(pagination).partial(),
    succes: { statut: 200, schema: pageV1(messageV1) }, erreurs: ['invalid_body', 'invalid_cursor', 'conversation_not_found'],
  },
  {
    methode: 'GET', chemin: '/v1/messages/{messageId}', droit: 'conversations:read', groupe: CV, operationId: 'getMessage',
    resume: 'Reads a message by its ID.', succes: { statut: 200, schema: messageV1 }, erreurs: ['message_not_found'],
  },
  {
    methode: 'GET', chemin: '/v1/messages/{messageId}/media', droit: 'conversations:read', groupe: CV, operationId: 'getMessageMedia',
    resume: 'Downloads the file of a received message.', succes: { statut: 200, schema: 'binaire' },
    erreurs: ['message_not_found', 'no_media', 'media_expired', 'media_unavailable'],
  },
  {
    methode: 'POST', chemin: '/v1/contacts', droit: 'contacts:write', groupe: C, operationId: 'upsertContact',
    resume: 'Creates or updates a record.', corps: schemaContactV1, succes: { statut: 200, schema: contactEcrit },
    erreurs: ['invalid_body', ...RESOLUTION, 'opted_out', 'plan_limit_reached'],
  },
  {
    methode: 'POST', chemin: '/v1/contacts/batch', droit: 'contacts:write', groupe: C, operationId: 'upsertContacts',
    resume: 'Creates or updates up to 50 records in one call.', corps: corpsLotDeFiches,
    succes: { statut: 200, schema: contactsLot }, erreurs: ['invalid_body'],
  },
  {
    methode: 'GET', chemin: '/v1/contacts/{contactId}', droit: 'contacts:read', groupe: C, operationId: 'getContact',
    resume: 'Reads a record.', parametres: z.object({ contactId: uuid }), succes: { statut: 200, schema: ficheApi }, erreurs: ['unknown_contact'],
  },
  {
    methode: 'POST', chemin: '/v1/contacts/search', droit: 'contacts:read', groupe: C, operationId: 'searchContact',
    resume: 'Finds a record by phone, BSUID or external id.',
    corps: schemaRechercheContactV1.describe('Exactly one of phone, bsuid or externalId.'),
    succes: { statut: 200, schema: contactTrouve }, erreurs: ['invalid_body', 'invalid_phone'],
  },
  {
    methode: 'DELETE', chemin: '/v1/contacts/{contactId}', droit: 'contacts:admin', groupe: C, operationId: 'deleteContact',
    resume: 'Erases a record for good (GDPR), within the plan’s daily limit.', parametres: z.object({ contactId: uuid }),
    succes: { statut: 200, schema: ficheEffacee }, erreurs: ['unknown_contact', 'plan_limit_reached'],
  },
  {
    methode: 'GET', chemin: '/v1/fields', droit: 'contacts:read', groupe: C, operationId: 'listFields',
    resume: 'Lists the custom fields: the keys to use in fields.', succes: { statut: 200, schema: champs }, erreurs: [],
  },
  {
    methode: 'POST', chemin: '/v1/fields', droit: 'contacts:admin', groupe: C, operationId: 'createField',
    resume: 'Creates a custom field; its key comes from the label.', corps: corpsChamp,
    succes: { statut: 201, schema: champV1 }, erreurs: ['invalid_body', 'field_exists'],
  },
  {
    methode: 'PATCH', chemin: '/v1/contacts/{contactId}', droit: 'contacts:write', groupe: C, operationId: 'updateContact',
    resume: 'Updates a record’s fields, tags, consent or external id.', parametres: z.object({ contactId: uuid }),
    corps: schemaPatchContactV1, succes: { statut: 200, schema: contactModifie },
    erreurs: ['invalid_body', 'invalid_phone', 'unknown_contact', 'identity_conflict', 'opted_out'],
  },
  {
    methode: 'POST', chemin: '/v1/messages', droit: 'sends:create', groupe: M, operationId: 'sendMessage',
    resume: 'Sends a message in Meta’s format: image, document, location, buttons, list, link button.',
    corps: schemaMessageMeta.describe('Name the person with to (the number with its country code), contactId or externalId. type names the content, and the object of the same name carries it, as at Meta.'),
    succes: { statut: 200, schema: reponseMessageSimple }, erreurs: MESSAGE_WHATSAPP,
  },
  {
    methode: 'POST', chemin: '/v1/messages/whatsapp', droit: 'sends:create', groupe: M, operationId: 'sendWhatsappText',
    resume: 'Sends a WhatsApp text right away to an existing record.', corps: schemaMessageWhatsapp,
    succes: { statut: 200, schema: reponseMessageSimple }, erreurs: MESSAGE_WHATSAPP,
  },
  {
    methode: 'POST', chemin: '/v1/messages/rcs', droit: 'sends:create', groupe: M, operationId: 'sendRcsText',
    resume: 'Sends an RCS text right away to an existing record.', corps: schemaMessageRcs,
    succes: { statut: 200, schema: reponseMessageSimple },
    erreurs: ['invalid_body', ...RESOLUTION, 'no_phone', 'blocked_contact', 'opted_out', 'no_consent', 'rcs_not_enabled', 'rcs_unreachable'],
  },
  {
    methode: 'POST', chemin: '/v1/sends', droit: 'sends:create', groupe: E, operationId: 'createSend',
    resume: 'Starts an asynchronous, idempotent send to 1 to 50 recipients.', corps: corpsEnvoi, idempotence: true,
    succes: { statut: 201, schema: rapportEnvoi },
    erreurs: [
      'invalid_body', 'idempotency_key_required', 'idempotency_in_progress', 'idempotency_key_reused', ...NUMERO,
      'template_not_found', 'template_category_unknown', 'unsendable_target', 'scenario_not_found', 'scenario_ambiguous',
      'node_not_found', 'rcs_message_not_found', 'rcs_not_enabled', 'plan_feature_unavailable', 'plan_limit_reached',
    ],
  },
  {
    methode: 'GET', chemin: '/v1/sends/{sendId}', droit: 'sends:create', groupe: E, operationId: 'getSend',
    resume: 'Reads the state and results of a send.', parametres: z.object({ sendId: uuid }),
    succes: { statut: 200, schema: suiviEnvoi }, erreurs: ['send_not_found'],
  },
  {
    methode: 'POST', chemin: '/v1/templates', droit: 'templates:write', groupe: T, operationId: 'createTemplate',
    resume: 'Creates a template in Meta’s format and submits it for review.', corps: schemaModeleMeta,
    succes: { statut: 201, schema: modeleCree },
    erreurs: ['invalid_body', 'invalid_header_media', 'template_rejected', 'meta_rejected', 'meta_auth_failed', 'no_whatsapp_number'],
  },
  {
    methode: 'GET', chemin: '/v1/templates/{name}', droit: 'templates:write', groupe: T, operationId: 'getTemplateStatus',
    resume: 'Reads a template’s status at Meta, language by language.', requete: requeteStatutModele,
    succes: { statut: 200, schema: statutModele },
    erreurs: ['invalid_body', 'template_not_found', 'meta_rejected', 'meta_auth_failed', 'no_whatsapp_number'],
  },
  {
    methode: 'GET', chemin: '/v1/webhooks', droit: 'webhooks:write', groupe: W, operationId: 'listWebhooks',
    resume: 'Lists the endpoints, the plan limit and the available types.',
    succes: { statut: 200, schema: listeWebhooks }, erreurs: [],
  },
  {
    methode: 'POST', chemin: '/v1/webhooks', droit: 'webhooks:write', groupe: W, operationId: 'createWebhook',
    resume: 'Registers an endpoint and returns its secret, only once.', corps: saisieCreation,
    succes: { statut: 201, schema: webhookCree },
    erreurs: ['invalid_body', 'plan_limit_reached', 'webhooks_unavailable'],
  },
  {
    methode: 'GET', chemin: '/v1/webhooks/{webhookId}', droit: 'webhooks:write', groupe: W, operationId: 'getWebhook',
    resume: 'Reads an endpoint and the state of its deliveries.', succes: { statut: 200, schema: webhookV1 }, erreurs: ['webhook_not_found'],
  },
  {
    methode: 'PATCH', chemin: '/v1/webhooks/{webhookId}', droit: 'webhooks:write', groupe: W, operationId: 'updateWebhook',
    resume: 'Changes the types, the description, or pauses the endpoint.', corps: saisieModification,
    succes: { statut: 200, schema: webhookV1 }, erreurs: ['invalid_body', 'webhook_not_found', 'plan_limit_reached'],
  },
  {
    methode: 'POST', chemin: '/v1/webhooks/{webhookId}/rotate-secret', droit: 'webhooks:write', groupe: W, operationId: 'rotateWebhookSecret',
    resume: 'Rotates the secret; the old one still signs for 24 h.',
    succes: { statut: 200, schema: secretTourne },
    erreurs: ['webhook_not_found', 'webhooks_unavailable'],
  },
  {
    methode: 'DELETE', chemin: '/v1/webhooks/{webhookId}', droit: 'webhooks:write', groupe: W, operationId: 'deleteWebhook',
    resume: 'Deletes an endpoint.', succes: { statut: 204, schema: null }, erreurs: ['webhook_not_found'],
  },
  {
    methode: 'POST', chemin: '/v1/webhooks/{webhookId}/test', droit: 'webhooks:write', groupe: W, operationId: 'testWebhook',
    resume: 'Sends a signed test event and returns the app’s answer.',
    succes: { statut: 200, schema: essaiWebhook }, erreurs: ['webhook_not_found', 'webhooks_unavailable'],
  },
  {
    methode: 'GET', chemin: '/v1/webhooks/{webhookId}/deliveries', droit: 'webhooks:write', groupe: W, operationId: 'listWebhookDeliveries',
    resume: 'Reads an endpoint’s log, most recent first.', requete: requeteJournal,
    succes: { statut: 200, schema: journalWebhook },
    erreurs: ['invalid_body', 'webhook_not_found'],
  },
  {
    methode: 'POST', chemin: '/v1/webhooks/deliveries/{deliveryId}/replay', droit: 'webhooks:write', groupe: W, operationId: 'replayWebhookDelivery',
    resume: 'Replays a finished delivery, with the same body.', succes: { statut: 202, schema: rejeu },
    erreurs: ['delivery_not_found', 'delivery_not_replayable'],
  },
  {
    methode: 'POST', chemin: '/v1/webhooks/{webhookId}/replay-failures', droit: 'webhooks:write', groupe: W, operationId: 'replayWebhookFailures',
    resume: 'Replays the failed deliveries since a date.', corps: corpsRejeu,
    succes: { statut: 202, schema: rejeuEchecs },
    erreurs: ['invalid_body', 'webhook_not_found'],
  },
  {
    methode: 'GET', chemin: '/v1/templates', droit: 'sends:create', groupe: K, operationId: 'listTemplates',
    resume: 'Lists the approved, sendable WhatsApp templates.',
    succes: { statut: 200, schema: reponseTemplates }, erreurs: [],
  },
  {
    methode: 'GET', chemin: '/v1/scenarios', droit: 'sends:create', groupe: K, operationId: 'listScenarios',
    resume: 'Lists the published scenarios and their opening message.',
    succes: { statut: 200, schema: reponseScenarios }, erreurs: [],
  },
  {
    methode: 'GET', chemin: '/v1/rcs-messages', droit: 'sends:create', groupe: K, operationId: 'listRcsMessages',
    resume: 'Lists the RCS messages of the library.',
    succes: { statut: 200, schema: reponseMessagesRcs }, erreurs: [],
  },
];
