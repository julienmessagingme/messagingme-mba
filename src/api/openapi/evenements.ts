import { z } from 'zod';
import { NIVEAUX_RISQUE, RAISONS_RISQUE } from '../../engagement/risque';
import type { TypeEvenement } from '../../evenements/types';
import type { EvenementOpenapi } from './document';

/**
 * CE QUE NOS WEBHOOKS SORTANTS ENVOIENT, en Zod, pour la section `webhooks` du contrat OpenAPI (lot 16). Le serveur
 * construit ces données en `Record<string, unknown>` (`donneesDuSignal`, `donneesStatutModele`, `besoin-reponse.ts`) :
 * il n'y a pas de type à comparer au typage, donc `tests/openapi.test.ts` fait passer dans chaque schéma ce que les
 * VRAIS constructeurs produisent, et tient ses clés égales à `CHAMPS_DU_TYPE`.
 */

const date = z.string().describe('ISO 8601 date-time');

/** L'enveloppe (`Enveloppe`, `src/evenements/types.ts`) ; `type` et `data` sont précisés par événement. */
export const enveloppeEvenement = z.object({
  id: z.string().describe('evt_ followed by 32 hex characters; stable across retries and replays. Also sent in webhook-id.'),
  type: z.string(),
  created_at: date,
  workspace_id: z.string().describe('The workspace (tenant) ID.'),
  data: z.record(z.string(), z.unknown()),
});

const contactPublic = z.object({
  id: z.string(),
  phone: z.string().nullable(),
  name: z.string().nullable(),
  external_id: z.string().nullable(),
  opted_out: z.object({ whatsapp: z.boolean(), rcs: z.boolean() }),
});
const canal = z.enum(['whatsapp', 'rcs']);
const niveau = z.enum(NIVEAUX_RISQUE);
const statutMessage = z.object({
  contact: contactPublic, channel: canal, message_id: z.string().nullable(), origin: z.string().nullable(), send_id: z.string().nullable(),
});

/** Le contenu de chaque type, et sa phrase. `Record<TypeEvenement, …>` : un type ajouté au serveur ne compile pas ici. */
const DONNEES: Readonly<Record<TypeEvenement, { resume: string; donnees: z.ZodObject; destinataires?: string }>> = {
  'message.received': {
    resume: 'A contact sent a message (WhatsApp or RCS).',
    donnees: z.object({
      contact: contactPublic, channel: canal, message_id: z.string().nullable(), message_type: z.string().nullable(),
      text: z.string().nullable(), transcription: z.string().nullable(), button: z.string().nullable(),
    }),
  },
  'message.delivered': { resume: 'A message we sent was delivered.', donnees: statutMessage },
  'message.read': { resume: 'A message we sent was read.', donnees: statutMessage },
  'message.failed': {
    resume: 'A message we sent failed.',
    donnees: statutMessage.extend({ reason: z.string().nullable(), meta_code: z.number().nullable() }),
  },
  'link.clicked': {
    resume: 'A contact clicked a tracked link.',
    donnees: z.object({ contact: contactPublic, link: z.string(), template: z.string().nullable(), destination: z.string().nullable() }),
  },
  'contact.opted_out': {
    resume: 'A contact opted out (STOP).',
    donnees: z.object({ contact: contactPublic, channel: canal.nullable(), source: z.string().nullable() }),
  },
  'conversation.analyzed': {
    resume: 'A conversation was analyzed (intent, sentiment, satisfaction, urgency).',
    donnees: z.object({
      contact: contactPublic, conversation_id: z.string().nullable(), intent: z.string(), sentiment: z.string(),
      satisfaction: z.number().nullable(), urgency: z.number().nullable(), resolved: z.boolean(), topic: z.string(),
      action_suggestion: z.string(), handled_by: z.string(), exchanges_count: z.number(), summary: z.string().nullable(),
    }),
  },
  'contact.risk_changed': {
    resume: 'A contact’s disengagement risk level changed.',
    donnees: z.object({
      contact: contactPublic, level: niveau, previous_level: niveau.nullable(), score: z.number().nullable(),
      reasons: z.array(z.enum(RAISONS_RISQUE)),
    }),
  },
  'template.status_changed': {
    resume: 'Meta approved, rejected, paused or disabled one of your templates.',
    donnees: z.object({
      template: z.object({ id: z.string(), name: z.string(), language: z.string() }),
      status: z.string().describe('Meta’s event, lowercase: approved, rejected, paused, disabled…'),
      reason: z.string().nullable(),
    }),
  },
  'conversation.needs_reply': {
    resume: 'Your application should reply.',
    destinataires: 'Sent only to the endpoint designated as the responder (the workspace answers through your application), whether or not it subscribed to this type.',
    donnees: z.object({
      contact: contactPublic.nullable(), conversation_id: z.string().nullable(), channel: z.literal('whatsapp'),
      message_id: z.string().nullable(), message_type: z.string().nullable(), text: z.string().nullable(),
      transcription: z.string().nullable(), reply_with: z.object({ method: z.literal('POST'), path: z.literal('/v1/messages/whatsapp') }),
    }),
  },
  test: {
    resume: 'A test event.',
    destinataires: 'Sent only by POST /v1/webhooks/{webhookId}/test, to that endpoint.',
    donnees: z.object({ message: z.string() }),
  },
};

export const EVENEMENTS_OPENAPI: readonly EvenementOpenapi[] = (Object.keys(DONNEES) as TypeEvenement[])
  .map((type) => {
    const d = DONNEES[type];
    return { type, resume: d.resume, donnees: d.donnees, ...(d.destinataires !== undefined ? { destinataires: d.destinataires } : {}) };
  });

/** Le schéma des données d'un type, pour les tests. */
export function donneesDe(type: TypeEvenement): z.ZodObject {
  return DONNEES[type].donnees;
}
