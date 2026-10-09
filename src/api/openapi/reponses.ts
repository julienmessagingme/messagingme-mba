import { z } from 'zod';
import { ACTIONS, HANDLED_BY, INTENTS, SENTIMENTS } from '../../analysis/schema';
import { NIVEAUX_RISQUE, RAISONS_RISQUE } from '../../engagement/risque';
import { STATUTS_MESSAGE } from '../conversations-v1';
import { CODES_ECART } from '../sends-build';
import { STATUT_PAR_CODE, type CodeApi } from '../erreurs';
import { TYPES_ABONNABLES } from '../../evenements/types';

/**
 * LES RÉPONSES DE L'API PUBLIQUE, EN ZOD, pour le contrat OpenAPI (lot 16). Les routes rendent des types TypeScript
 * (`FicheApi`, `ConversationV1`…) ; ces schémas les décrivent pour un intégrateur, et `tests/openapi.test.ts`
 * exige au TYPAGE que chacun soit exactement le type que sa route rend, dans les deux sens : un champ ajouté, retiré ou
 * renommé côté serveur casse la CI au lieu de laisser le contrat mentir. Les listes de valeurs viennent du serveur.
 */

const enumDe = <T extends readonly [string, ...string[]]>(valeurs: T) => z.enum(valeurs);
const date = z.string().describe('ISO 8601 date-time');

/** Une page : les éléments et le curseur de la suivante (`null` : dernière page). */
export const pageV1 = <T extends z.ZodType>(element: T) => z.object({ data: z.array(element), nextCursor: z.string().nullable() });

export const conversationV1 = z.object({
  id: z.string(),
  contact: z.object({ id: z.string().nullable(), phone: z.string().nullable(), name: z.string().nullable(), externalId: z.string().nullable() }),
  lastMessageAt: date,
  lastDirection: z.enum(['in', 'out']).nullable(),
  windowExpiresAt: date.nullable(),
  handledBy: z.enum(['team', 'meta_agent', 'automation']),
  needsReply: z.boolean(),
  archived: z.boolean(),
});

export const messageV1 = z.object({
  id: z.string(),
  conversationId: z.string(),
  direction: z.enum(['in', 'out']),
  channel: z.enum(['whatsapp', 'rcs']),
  type: z.string().nullable(),
  text: z.string().nullable(),
  buttonPayload: z.string().nullable(),
  transcription: z.string().nullable(),
  media: z.object({ mimeType: z.string().nullable(), filename: z.string().nullable(), expired: z.boolean() }).nullable(),
  status: enumDe(STATUTS_MESSAGE).nullable(),
  statusAt: date.nullable(),
  error: z.object({ code: z.number().nullable(), reason: z.string().nullable() }).nullable(),
  createdAt: date,
});

export const engagementRisk = z.object({
  level: enumDe(NIVEAUX_RISQUE),
  score: z.number().nullable(),
  reasons: z.array(enumDe(RAISONS_RISQUE)),
  computedAt: date,
});

export const lastAnalysis = z.object({
  intent: enumDe(INTENTS),
  sentiment: enumDe(SENTIMENTS),
  satisfaction: z.number().nullable(),
  urgency: z.number().nullable(),
  resolved: z.boolean(),
  topic: z.string(),
  handledBy: enumDe(HANDLED_BY),
  actionSuggestion: enumDe(ACTIONS),
  analyzedAt: date,
});

export const ficheApi = z.object({
  contactId: z.string(),
  externalId: z.string().nullable(),
  phone: z.string().nullable(),
  bsuid: z.string().nullable(),
  name: z.string().nullable(),
  fields: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()),
  consent: z.object({ status: z.enum(['opted_in', 'opted_out', 'unknown']), source: z.string().nullable(), optedOutAt: date.nullable() }),
  rcsOptedOutAt: date.nullable(),
  blocked: z.boolean(),
  reachability: z.object({ whatsapp: z.boolean().nullable(), rcs: z.boolean().nullable() }),
  engagementRisk: engagementRisk.nullable(),
  lastAnalysis: lastAnalysis.nullable(),
  createdAt: date,
});

const codesApi = Object.keys(STATUT_PAR_CODE) as [CodeApi, ...CodeApi[]];

export const resultatFiche = z.union([
  z.object({ index: z.number(), status: z.enum(['created', 'updated']), contactId: z.string() }),
  z.object({ index: z.number(), status: z.literal('error'), code: z.enum(codesApi), reason: z.string() }),
]);

export const contactEcrit = z.object({ contactId: z.string(), status: z.enum(['created', 'updated']) });
export const contactsLot = z.object({ results: z.array(resultatFiche), created: z.number(), updated: z.number(), errors: z.number() });
export const contactTrouve = z.object({ contact: ficheApi.nullable() });
export const contactModifie = z.object({ contactId: z.string() });
export const ficheEffacee = z.object({ deleted: z.literal(true), conversations: z.number(), messages: z.number() });

export const champV1 = z.object({ key: z.string(), label: z.string(), type: z.string() });
export const champs = z.object({ data: z.array(champV1) });

export const reponseMessageSimple = z.object({
  messageId: z.string(),
  conversationId: z.string().nullable(),
  channel: z.enum(['whatsapp', 'rcs']),
});

const ouverture = z.enum(['whatsapp_template', 'whatsapp_session', 'rcs']);

export const rapportEnvoi = z.object({
  sendId: z.string(),
  opening: ouverture,
  recipientCount: z.number(),
  created: z.number(),
  matched: z.number(),
  skipped: z.array(z.object({ index: z.number(), reason: enumDe(CODES_ECART) })),
  skippedTotal: z.number(),
});

export const suiviEnvoi = z.object({
  sendId: z.string(),
  status: z.enum(['draft', 'running', 'paused', 'completed', 'failed', 'scheduled']),
  target: z.union([
    z.object({ template: z.object({ name: z.string(), language: z.string() }) }),
    z.object({ scenario: z.string().nullable() }),
    z.object({ node: z.string().nullable() }),
    z.object({ rcsMessage: z.string().nullable() }),
  ]),
  opening: ouverture.nullable(),
  createdAt: date,
  counts: z.object({ pending: z.number(), sending: z.number(), sent: z.number(), failed: z.number(), skipped: z.number() }),
  recipientsTotal: z.number(),
  recipients: z.array(z.object({
    contactId: z.string(),
    externalId: z.string().nullable(),
    channel: z.enum(['whatsapp', 'rcs', 'email']),
    status: z.string(),
    messageId: z.string().nullable(),
    delivery: z.string().nullable(),
    error: z.object({ message: z.string(), metaCode: z.number().nullable() }).nullable(),
    sentAt: date.nullable(),
  })),
});

export const modeleCree = z.object({ id: z.string(), name: z.string(), language: z.string(), category: z.string(), status: z.string() });
export const statutLangue = z.object({ language: z.string(), status: z.string(), category: z.string().nullable(), rejectedReason: z.string().nullable() });
export const statutModele = z.object({ name: z.string(), languages: z.array(statutLangue) });

/** D'où vient la valeur d'une variable de template (`ParamSource`, `src/crm/template.ts`). */
export const paramSource = z.union([
  z.object({ type: z.literal('field'), key: z.string() }),
  z.object({ type: z.literal('attribute'), key: z.enum(['name', 'phone', 'bsuid', 'wa_id']) }),
  z.object({ type: z.literal('now') }),
  z.object({ type: z.literal('literal'), value: z.string() }),
  z.object({ type: z.literal('variable'), key: z.string() }),
]);

export const templateCatalogue = z.object({
  name: z.string(),
  language: z.string(),
  category: z.enum(['marketing', 'utility']),
  header: z.enum(['none', 'text', 'image', 'video', 'document']),
  variables: z.array(z.object({ position: z.number(), source: paramSource.nullable() })),
});
export const scenarioCatalogue = z.object({
  code: z.string().nullable(),
  name: z.string(),
  opening: ouverture.nullable(),
  openingTemplate: z.object({ name: z.string(), language: z.string() }).nullable(),
  entryNode: z.string().nullable(),
  publishedAt: date.nullable(),
});
export const messageRcsCatalogue = z.object({ name: z.string(), kind: z.enum(['text', 'card', 'carousel']), variables: z.array(z.string()) });

export const webhookV1 = z.object({
  id: z.string(),
  url: z.string(),
  description: z.string(),
  types: z.array(z.string()),
  active: z.boolean(),
  createdAt: date,
  previousSecretValidUntil: date.nullable(),
  lastDeliveredAt: date.nullable(),
  retrying: z.number(),
  failed: z.number(),
});
export const deliveryV1 = z.object({
  id: z.string(),
  eventId: z.string(),
  type: z.string(),
  status: z.enum(['pending', 'delivered', 'failed']),
  attempts: z.number(),
  lastStatusCode: z.number().nullable(),
  lastResponse: z.string().nullable(),
  nextAttemptAt: date.nullable(),
  createdAt: date,
  deliveredAt: date.nullable(),
  body: z.string().describe('The exact body that was sent, byte for byte.'),
});

/** Les réponses des routes des webhooks (`ListeWebhooksV1`… dans `src/http/v1-webhooks.ts`). */
export const listeWebhooks = z.object({
  data: z.array(webhookV1),
  limit: z.number().nullable().describe('The plan’s maximum number of endpoints; null: unlimited.'),
  types: z.array(z.enum(TYPES_ABONNABLES)),
  defaultTypes: z.array(z.enum(TYPES_ABONNABLES)),
});
export const webhookCree = z.object({ webhook: webhookV1, secret: z.string().describe('whsec_…, returned only here and at rotation.') });
export const secretTourne = z.object({ secret: z.string(), previousSecretValidUntil: date });
export const essaiWebhook = z.object({ eventId: z.string(), delivered: z.boolean(), statusCode: z.number().nullable(), response: z.string() });
export const journalWebhook = z.object({ data: z.array(deliveryV1), nextBefore: date.nullable().describe('Pass it as before for the next page.') });
export const rejeu = z.object({ replayed: z.literal(true) });
export const rejeuEchecs = z.object({ replayed: z.number().describe('How many deliveries were replayed.') });

/** Les trois catalogues (`CatalogueTemplatesV1`… dans `src/http/v1-catalogues.ts`). */
export const reponseTemplates = z.object({ templates: z.array(templateCatalogue) });
export const reponseScenarios = z.object({ scenarios: z.array(scenarioCatalogue) });
export const reponseMessagesRcs = z.object({ rcsMessages: z.array(messageRcsCatalogue) });
